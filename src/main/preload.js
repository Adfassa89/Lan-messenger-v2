'use strict';
// Exposes a small, safe API to the user interface. The page itself has no
// access to Node.js or the file system.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('api', {
  init: invoke('init'),
  loadMessages: invoke('load-messages'),
  sendText: invoke('send-text'),
  sendFiles: invoke('send-files'),
  pickFiles: invoke('pick-files'),
  sendImageData: invoke('send-image-data'),
  acceptFile: invoke('accept-file'),
  cancelFile: invoke('cancel-file'),
  openFile: invoke('open-file'),
  showInFolder: invoke('show-in-folder'),
  openExternal: invoke('open-external'),
  copyText: invoke('copy-text'),
  thumb: invoke('thumb'),
  markRead: invoke('mark-read'),
  typing: invoke('typing'),
  setActiveConv: invoke('active-conv'),
  setProfile: invoke('set-profile'),
  setSettings: invoke('set-settings'),
  pickFolder: invoke('pick-folder'),
  createGroup: invoke('create-group'),
  updateGroup: invoke('update-group'),
  leaveGroup: invoke('leave-group'),
  search: invoke('search'),
  addPeer: invoke('add-peer'),
  removePeer: invoke('remove-peer'),
  forgetContact: invoke('forget-contact'),
  deleteMessage: invoke('delete-message'),
  clearConversation: invoke('clear-conversation'),
  setBadge: invoke('set-badge'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (fn) => ipcRenderer.on('evt', (_e, data) => fn(data)),
});
