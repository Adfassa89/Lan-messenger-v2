'use strict';
// Exposes a small, safe API to the user interface. The pages themselves have
// no access to Node.js or the file system.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (name) => (...args) => ipcRenderer.invoke(name, ...args);

const CHANNELS = {
  init: 'init',
  loadMessages: 'load-messages',
  getMessage: 'get-message',
  sendText: 'send-text',
  sendFiles: 'send-files',
  pickFiles: 'pick-files',
  pickSendFolder: 'pick-send-folder',
  sendImageData: 'send-image-data',
  sendVoice: 'send-voice',
  readMedia: 'read-media',
  readImage: 'read-image',
  acceptFile: 'accept-file',
  cancelFile: 'cancel-file',
  openFile: 'open-file',
  showInFolder: 'show-in-folder',
  openExternal: 'open-external',
  copyText: 'copy-text',
  thumb: 'thumb',
  markRead: 'mark-read',
  typing: 'typing',
  setActiveConv: 'active-conv',
  setProfile: 'set-profile',
  pickAvatar: 'pick-avatar',
  removeAvatar: 'remove-avatar',
  setSettings: 'set-settings',
  pickFolder: 'pick-folder',
  createGroup: 'create-group',
  updateGroup: 'update-group',
  leaveGroup: 'leave-group',
  search: 'search',
  addPeer: 'add-peer',
  removePeer: 'remove-peer',
  forgetContact: 'forget-contact',
  deleteMessage: 'delete-message',
  clearConversation: 'clear-conversation',
  react: 'react',
  editMessage: 'edit-message',
  unsendMessage: 'unsend-message',
  pinMessage: 'pin-message',
  createPoll: 'create-poll',
  vote: 'vote',
  ackUrgent: 'ack-urgent',
  scheduleMessage: 'schedule-message',
  cancelScheduled: 'cancel-scheduled',
  exportChat: 'export-chat',
  captureScreen: 'capture-screen',
  shareSources: 'share-sources',
  shareSelect: 'share-select',
  rtcSend: 'rtc-send',
  openViewer: 'open-viewer',
  callStart: 'call-start',
  createGame: 'create-game',
  gameMove: 'game-move',
  callInfo: 'call-info',
  callAccept: 'call-accept',
  callDecline: 'call-decline',
  callConnected: 'call-connected',
  callEnded: 'call-ended',
  openConv: 'open-conv',
  restartUpdate: 'restart-update',
  setBadge: 'set-badge',
  setTitleBar: 'set-title-bar',
};

const api = {};
for (const [name, channel] of Object.entries(CHANNELS)) api[name] = invoke(channel);
api.pathForFile = (file) => webUtils.getPathForFile(file);
api.on = (fn) => ipcRenderer.on('evt', (_e, data) => fn(data));

contextBridge.exposeInMainWorld('api', api);
