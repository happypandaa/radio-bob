export function controlIntent(message) {
  const value = message.trim().replace(/[。！!，,～~\s]/g, '').toLowerCase();
  if (/^(暂停|暂停一下|先暂停|停一下|pause)$/.test(value)) return 'pause';
  if (/^(播放|继续播放|继续|开始播放|play|resume)$/.test(value)) return 'play';
  if (/^(下一首|换一首|切歌|跳过|next|skip)$/.test(value)) return 'next';
  if (/^(上一首|回到上一首|previous|prev)$/.test(value)) return 'previous';
  // Short replies to Bob's "continue with these?" question at the end of a set.
  if (/^(好|好的|好啊|好呀|可以|行|来吧|走起|就这些|就听这些|听这些|接着放|接着听|好接着放|好接着听|ok|okay|yes|嗯|嗯嗯)$/.test(value)) return 'accept';
  return null;
}
