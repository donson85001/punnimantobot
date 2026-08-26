// Hotfix 2026-08-26: current GAS no longer supports legacy chat_add.
// !新增點歌 maps to the supported wish_add action used by the KTV audience page.
addNewSong = async function(q, user, room) {
  const res = await gas('wish_add', { song: q, user });
  if (!res || res.ok === false) {
    throw new Error(res?.error || res?.message || '新增點歌失敗');
  }
  return `@${user} 已新增點歌：${q}`;
};

console.log('ADD_SONG_HOTFIX', 'wish_add-v1');
