type TileRequest = {
  tileX: number;
  tileY: number;
};

self.addEventListener('message', async (e: MessageEvent<TileRequest>) => {
  const { tileX, tileY } = e.data;
  const originalUrl = `https://backend.wplace.live/files/s0/tiles/${tileX}/${tileY}.png`;
  const url = `/api/proxy?url=${encodeURIComponent(originalUrl)}`;
  
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    self.postMessage({
      tileX,
      tileY,
      blob,
      success: true
    });
  } catch (error) {
    self.postMessage({
      tileX,
      tileY,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});