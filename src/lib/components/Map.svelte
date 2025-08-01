<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Map as MapLibre } from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";

  let map: MapLibre;
  let mapContainer: HTMLDivElement;

  let activeTiles = new Set<string>();
  let tileWorker: Worker;

  let previousTileImage = new Map<string, Blob>();
  let activeTileImage = new Map<string, Blob>();
  let accumulatedDiff = new Map<string, Blob>();

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
    const tileSize = 360 / n; // tile size in degrees at zoom level 11

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
          coordinates: [[...imageBounds, imageBounds[0]]], // close the polygon
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

    map.moveLayer(draggedImageId, draggedImageHitBoxId);

    // add event listeners for dragging
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

    // update the image
    if (map.getSource(draggedImageId)) {
      (map.getSource(draggedImageId) as any).setCoordinates(imageBounds);
    }

    // update the hitbox
    if (map.getSource(draggedImageHitBoxId)) {
      (map.getSource(draggedImageHitBoxId) as any).setData({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[...imageBounds, imageBounds[0]]] // close the polygon
        }
      });
    }
  }

  function addTileLayer(tileX: number, tileY: number, imageUrl: string) {
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
      url: imageUrl,
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

  async function calculateTileDiff(tileX: number, tileY: number): Promise<Blob | null> {
    const tileKey = `${tileX}-${tileY}`;
    const previousImage = previousTileImage.get(tileKey);
    const currentImage = activeTileImage.get(tileKey);
    const accumulated = accumulatedDiff.get(tileKey);

    if (!previousImage || !currentImage) {
      console.warn(`No previous or current image for tile ${tileKey}`);
      return null;
    }

    return Promise.all([
      createImageBitmap(previousImage),
      createImageBitmap(currentImage),
      accumulated ? createImageBitmap(accumulated) : null
    ]).then(([prevBitmap, currBitmap, accumBitmap]) => {
      const width = Math.min(prevBitmap.width, currBitmap.width);
      const height = Math.min(prevBitmap.height, currBitmap.height);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

      if (!accumBitmap) {
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, width, height);
      } else {
        ctx.drawImage(accumBitmap, 0, 0, width, height);
      }
      const baseData = ctx.getImageData(0, 0, width, height);

      // Draw previous image
      ctx.drawImage(prevBitmap, 0, 0, width, height);
      const prevData = ctx.getImageData(0, 0, width, height);

      // Draw current image
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(currBitmap, 0, 0, width, height);
      const currData = ctx.getImageData(0, 0, width, height);

      // Prepare output
      const outData = ctx.createImageData(width, height);

      for (let i = 0; i < prevData.data.length; i += 4) {
        const isTransparent = 
          prevData.data[i + 3] < 10 || // Alpha channel próximo de 0 na imagem anterior
          currData.data[i + 3] < 10;   // Alpha channel próximo de 0 na imagem atual

        if (isTransparent) {
          // Se for transparente, mantém o valor base sem alteração
          outData.data[i] = baseData.data[i];       // Red
          outData.data[i + 1] = baseData.data[i + 1];// Green
          outData.data[i + 2] = baseData.data[i + 2];// Blue
          outData.data[i + 3] = 255;                 // Alpha
          continue;
        }


        // Detecta mudança em qualquer canal
        const changed =
          prevData.data[i] !== currData.data[i] ||
          prevData.data[i + 1] !== currData.data[i + 1] ||
          prevData.data[i + 2] !== currData.data[i + 2];

        if (changed) {
          // Se houve mudança, copia a cor atual
          const grayValue = Math.min(baseData.data[i] + 20, 255);
          outData.data[i] = grayValue;        // Red
          outData.data[i + 1] = grayValue;    // Green
          outData.data[i + 2] = grayValue;    // Blue
          outData.data[i + 3] = 255;          // Alpha
        } else {
          // Se não houve mudança, mantém a cor acumulada anterior
          outData.data[i] = baseData.data[i];       // Red
          outData.data[i + 1] = baseData.data[i + 1];// Green
          outData.data[i + 2] = baseData.data[i + 2];// Blue
          outData.data[i + 3] = 255;                 // Alpha
        }
      }

      ctx.putImageData(outData, 0, 0);
      return new Promise<Blob>((resolve) => {
        canvas.toBlob((blob) => resolve(blob!), 'image/png');
      });
    });
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
    console.log('Map moved, checking tiles...');
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
      tileWorker.postMessage({ tileX: tile.x, tileY: tile.y });
    });
  }

  onMount(() => {
    tileWorker = new Worker(
      new URL('../workers/tile-worker.ts', import.meta.url),
      { type: 'module' }
    );

    tileWorker.onmessage = async (e) => {
      const { tileX, tileY, imageUrl, success, imageBlob } = e.data;
      if (success) {
        // addTileLayer(tileX, tileY, imageUrl);
        if (imageBlob) {
          const tileKey = `${tileX}-${tileY}`;

          removeTileLayer(tileX, tileY); // Remove any existing layer for this tile
          
          // Se não tem imagem anterior, usa a atual como anterior
          if (!previousTileImage.has(tileKey)) {
            previousTileImage.set(tileKey, imageBlob.slice(0));
            activeTileImage.set(tileKey, imageBlob);
          } else {
            // Se já tem imagem anterior, atualiza normalmente
            previousTileImage.set(tileKey, activeTileImage.get(tileKey)!);
            activeTileImage.set(tileKey, imageBlob);
          }

          const diffBlob = await calculateTileDiff(tileX, tileY);
          if (diffBlob) {
            accumulatedDiff.set(tileKey, diffBlob);
            
            const diffUrl = URL.createObjectURL(diffBlob);
            addTileLayer(tileX, tileY, diffUrl);
            
            // Limpa a URL após um tempo para evitar vazamento de memória
            setTimeout(() => URL.revokeObjectURL(diffUrl), 1000);
          }
        }
      }
    };

    let initialState = { lng: -54.61432, lat: -20.47068, zoom: 11 };
    const saved = loadMapState();
    if (saved) initialState = saved;

    map = new MapLibre({
      container: mapContainer,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [initialState.lng, initialState.lat],
      zoom: initialState.zoom,
    });

    map.on("moveend", () => {
      saveMapState();
      handleMapMove();
    });

    setInterval(() => {
      handleMapMove();
    }, 5000); // Delay to ensure map is fully loaded
  });

  onDestroy(() => {
    map.off('moveend', handleMapMove);
    map.remove();

    if (uploadedImageUrl) {
      URL.revokeObjectURL(uploadedImageUrl);
    }

    tileWorker?.terminate();

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
  <!-- TODO: The image doesn't align correctly with the map tiles, so it's commented out for now -->
  <!-- <input type="file" accept="image/*" on:change={handleFileUpload} /> -->
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
