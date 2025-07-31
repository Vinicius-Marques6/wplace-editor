<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Map } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";

  let map: Map;
  let mapContainer: HTMLDivElement;

  let activeTiles = new Set<string>();
  let tileWorker: Worker;

  let uploadedImageUrl: string | null = null;
  let draggedImageId = 'draggable-image';
  let draggedImageHitBoxId = 'draggable-image-hitbox';
  let isDragging = false;
  let dragStartPos: maplibregl.Point | null = null;
  let imagePosition = { lng: -54.61432, lat: -20.47068 };

  let imageAspectRatio = 1;
  let imageWidth: number;
  let imageHeight: number;

  function handleFileUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    if (uploadedImageUrl) {
      URL.revokeObjectURL(uploadedImageUrl);
    }
    uploadedImageUrl = URL.createObjectURL(file);
    imagePosition = map.getCenter();
    addDraggableImage(uploadedImageUrl);
  }

  function centerOnGPS() {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition((position) => {
      const { latitude, longitude } = position.coords;
      map.flyTo({ center: [longitude, latitude], zoom: 16 });
    });
  }

  function saveMapState() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const state = { lng: center.lng, lat: center.lat, zoom };
    localStorage.setItem('mapState', JSON.stringify(state));
  }

  function loadMapState() {
    const state = localStorage.getItem('mapState');
    if (state) {
      const { lng, lat, zoom } = JSON.parse(state);
      return { lng, lat, zoom };
    }
    return null;
  }

  async function addDraggableImage(imageUrl: string) {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = imageUrl;
    });

    imageWidth = img.width;
    imageHeight = img.height;
    imageAspectRatio = imageHeight / imageWidth;

    const n = Math.pow(2, 11);
    const tileSize = 360 / n; // tamanho do tile em graus

    const adjustedHeight = tileSize * imageAspectRatio;

    const imageBounds: [[number, number], [number, number], [number, number], [number, number]] = [
      [imagePosition.lng, imagePosition.lat + adjustedHeight], // top-left
      [imagePosition.lng + tileSize, imagePosition.lat + adjustedHeight], // top-right
      [imagePosition.lng + tileSize, imagePosition.lat], // bottom-right
      [imagePosition.lng, imagePosition.lat], // bottom-left
    ];

    // Hitbox para o arrasto
    map.addSource(draggedImageHitBoxId, {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[...imageBounds, imageBounds[0]]], // fecha o polígono
        }
      }
    });

    map.addLayer({
      id: draggedImageHitBoxId,
      type: 'fill',
      source: draggedImageHitBoxId,
      paint: {
        'fill-color': '#888888',
        'fill-opacity': 0
      },
    });

    map.addSource(draggedImageId, {
      type: 'image',
      url: imageUrl,
      coordinates: imageBounds
    });

    map.addLayer({
      id: draggedImageId,
      type: 'raster',
      source: draggedImageId,
      paint: {
        'raster-opacity': 0.8,
        'raster-resampling': 'nearest'
      },
    });

    //map.moveLayer(draggedImageId);
    map.moveLayer(draggedImageId, draggedImageHitBoxId);

    // Adiciona os eventos de mouse para arrastar
    map.on('mousedown', draggedImageHitBoxId, startDragging);
    map.on('mousemove', handleDragging);
    map.on('mouseup', stopDragging);
  }

  function tileToLngLat(x: number, y: number, zoom: number) {
    const n = Math.pow(2, zoom);
    const lng = (x / n) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    return { lng, lat };
  }

  function startDragging(e: any) {
    e.preventDefault();
    isDragging = true;
    dragStartPos = e.point;
    map.getCanvas().style.cursor = 'grab';
  }

  function handleDragging(e: any) {
    if (!isDragging || !dragStartPos) return;

    const currentPoint = e.point;
    const startLatLng = map.unproject(dragStartPos);
    const currentLatLng = map.unproject(currentPoint);
    
    const deltaLng = currentLatLng.lng - startLatLng.lng;
    const deltaLat = currentLatLng.lat - startLatLng.lat;

    imagePosition = {
      lng: imagePosition.lng + deltaLng,
      lat: imagePosition.lat + deltaLat
    };

    dragStartPos = currentPoint;

    updateImagePosition();
  }

  function stopDragging() {
    if (!isDragging) return;

    isDragging = false;
    dragStartPos = null;
    map.getCanvas().style.cursor = '';

    // Snap to grid
    const zoom = 60;
    const tile = lngLatToTile(imagePosition.lng, imagePosition.lat, zoom);
    const snappedPos = tileToLngLat(tile.x, tile.y, zoom);
    imagePosition = snappedPos;
    updateImagePosition();
  }

  function updateImagePosition() {
    const n = Math.pow(2, 11);
    const tileSize = 360 / n;
    const adjustedHeight = tileSize * imageAspectRatio;

    const imageBounds = [
        [imagePosition.lng, imagePosition.lat + adjustedHeight],
        [imagePosition.lng + tileSize, imagePosition.lat + adjustedHeight],
        [imagePosition.lng + tileSize, imagePosition.lat],
        [imagePosition.lng, imagePosition.lat]
    ];

    // Atualiza a imagem
    if (map.getSource(draggedImageId)) {
      (map.getSource(draggedImageId) as any).setCoordinates(imageBounds);
    }

    // Atualiza o hitbox
    if (map.getSource(draggedImageHitBoxId)) {
      (map.getSource(draggedImageHitBoxId) as any).setData({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[...imageBounds, imageBounds[0]]] // fecha o polígono
        }
      });
    }
  }

  function addTileLayer(tileX: number, tileY: number, url: string) {
    const tileKey = `${tileX}-${tileY}`;
    if (activeTiles.has(tileKey)) return;

    const sourceId = `tile-source-${tileKey}`;
    const layerId = `tile-layer-${tileKey}`;

    const n = Math.pow(2, 11);
    const lon1 = (tileX / n) * 360 - 180;
    const lat1 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n))) * 180) / Math.PI;
    const lon2 = ((tileX + 1) / n) * 360 - 180;
    const lat2 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + 1)) / n))) * 180) / Math.PI;

    map.addSource(sourceId, {
      type: "image",
      url,
      coordinates: [
        [lon1, lat1],
        [lon2, lat1],
        [lon2, lat2],
        [lon1, lat2],
      ],
    });

    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      paint: {
        "raster-opacity": 1,
        "raster-resampling": "nearest",
      },
      layout: {
        "visibility": "visible"
      }
    });

    activeTiles.add(tileKey);
  }

  function removeTileLayer(tileX: number, tileY: number) {
    const tileKey = `${tileX}-${tileY}`;
    const sourceId = `tile-source-${tileKey}`;
    const layerId = `tile-layer-${tileKey}`;

    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    activeTiles.delete(tileKey);
  }

  function getVisibleTiles() {
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    if (zoom < 11) return [];

    const nw = lngLatToTile(bounds.getNorthWest().lng, bounds.getNorthWest().lat, 11);
    const se = lngLatToTile(bounds.getSouthEast().lng, bounds.getSouthEast().lat, 11);

    const tiles = [];
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) {
        tiles.push({ x, y });
      }
    }
    return tiles;
  }

  function lngLatToTile(lng: number, lat: number, zoom: number) {
    const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
    const y = Math.floor(
      ((1 -
        Math.log(
          Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)
        ) /
          Math.PI) /
        2) *
        Math.pow(2, zoom)
    );
    return { x, y };
  }

  function handleMapMove() {
    const zoom = map.getZoom();
    if (zoom < 11) {
      Array.from(activeTiles).forEach(tileKey => {
        const [x, y] = tileKey.split('-').map(Number);
        removeTileLayer(x, y);
      });
      return;
    }

    const visibleTiles = getVisibleTiles();
    const visibleTileKeys = new Set(visibleTiles.map(t => `${t.x}-${t.y}`));

    // Remove tiles that are no longer visible
    Array.from(activeTiles).forEach(tileKey => {
      if (!visibleTileKeys.has(tileKey)) {
        const [x, y] = tileKey.split('-').map(Number);
        removeTileLayer(x, y);
      }
    });

    // Request new tiles
    visibleTiles.forEach(tile => {
      const tileKey = `${tile.x}-${tile.y}`;
      if (!activeTiles.has(tileKey)) {
        tileWorker.postMessage({ tileX: tile.x, tileY: tile.y });
      }
    });
  }

  onMount(() => {
    tileWorker = new Worker(
      new URL('../workers/tile-worker.ts', import.meta.url),
      { type: 'module' }
    );

    tileWorker.onmessage = async (e) => {
      const { tileX, tileY, blob, success } = e.data;
      if (success) {
        const objectUrl = URL.createObjectURL(blob);
        addTileLayer(tileX, tileY, objectUrl);
      }
    };

    let initialState = { lng: -54.61432, lat: -20.47068, zoom: 11 };
    const saved = loadMapState();
    if (saved) initialState = saved;

    map = new Map({
      container: mapContainer,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [initialState.lng, initialState.lat],
      zoom: initialState.zoom,
    });

    map.on("moveend", () => {
      saveMapState();
      handleMapMove();
    });
  });

  onDestroy(() => {
    map.off('moveend', handleMapMove);
    map.remove();

    if (uploadedImageUrl) {
      URL.revokeObjectURL(uploadedImageUrl);
    }

    tileWorker?.terminate();
    activeTiles.forEach(tileKey => {
      URL.revokeObjectURL(tileKey);
    });

    if (map) {
      console.log('Removing draggable image:', draggedImageId);
      map.off('mousedown', draggedImageId, startDragging);
      map.off('mousemove', handleDragging);
      map.off('mouseup', stopDragging);
    }
  });

  function getTileAtZoom11() {
    const center = map.getCenter();
    return lngLatToTile(center.lng, center.lat, 11);
  }
</script>

<div class="controls">
  <input type="file" accept="image/*" on:change={handleFileUpload} />
  <button on:click={centerOnGPS} style="margin-left:8px;">Centralizar no GPS</button>
</div>
<div class="map-wrap">
  <div class="map" bind:this={mapContainer}></div>
</div>

<style>
  .map-wrap {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .map {
    position: absolute;
    width: 100%;
    height: 100%;
  }

  :global(.maplibregl-canvas-container) {
    cursor: default;
  }

  .controls {
    position: absolute;
    z-index: 10;
    left: 10px;
    top: 10px;
    background: white;
    padding: 4px;
    border-radius: 4px;
  }
</style>
