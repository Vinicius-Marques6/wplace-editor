type TileRequest = {
  tileX: number;
  tileY: number;
};

self.addEventListener('message', async (e: MessageEvent<TileRequest>) => {
  const { tileX, tileY } = e.data;
  const originalUrl = `https://backend.wplace.live/files/s0/tiles/${tileX}/${tileY}.png`;
  const imageUrl = `/api/proxy?url=${encodeURIComponent(originalUrl)}`;
  try {
    self.postMessage({
      tileX,
      tileY,
      imageUrl,
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