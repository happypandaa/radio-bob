export function controlIntent(message) {
  const value = message.trim().replace(/[。！!，,\s]/g, '').toLowerCase();
  if (/^(暂停|暂停一下|先暂停|停一下|pause)$/.test(value)) return 'pause';
  if (/^(播放|继续播放|继续|开始播放|play|resume)$/.test(value)) return 'play';
  if (/^(下一首|换一首|切歌|跳过|next|skip)$/.test(value)) return 'next';
  if (/^(上一首|回到上一首|previous|prev)$/.test(value)) return 'previous';
  return null;
}
