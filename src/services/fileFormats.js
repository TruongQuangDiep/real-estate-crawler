// Preserve the original format. Never rename a ZIP or an old XLS into XLSX.
const TYPES = {
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls:'application/vnd.ms-excel',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc:'application/msword',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt:'application/vnd.ms-powerpoint',
  pdf:'application/pdf', csv:'text/csv', tsv:'text/tab-separated-values', txt:'text/plain', json:'application/json',
  zip:'application/zip', rar:'application/vnd.rar', '7z':'application/x-7z-compressed',
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
  heic:'image/heic', heif:'image/heif', avif:'image/avif', bmp:'image/bmp', tif:'image/tiff', tiff:'image/tiff', svg:'image/svg+xml',
  mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm', mp3:'audio/mpeg', m4a:'audio/mp4', wav:'audio/wav',
  odt:'application/vnd.oasis.opendocument.text', ods:'application/vnd.oasis.opendocument.spreadsheet', odp:'application/vnd.oasis.opendocument.presentation',
};
function extension(url) { return String(url).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() || ''; }
const isDocumentUrl = url => Boolean(TYPES[extension(url)] && !TYPES[extension(url)].startsWith('image/'));
function detectExtraFormat(buffer, header, filename, allowDocuments) {
  const ext = extension(filename), mime = String(header).split(';')[0].trim().toLowerCase();
  if (!allowDocuments && !['svg','tif','tiff'].includes(ext)) return null;
  if (buffer.subarray(0,4).toString('hex') === '504b0304') {
    const office = ['xlsx','docx','pptx','odt','ods','odp'].find(k => k === ext || TYPES[k] === mime);
    return office ? {ext:office,mimeType:TYPES[office]} : {ext:'zip',mimeType:TYPES.zip};
  }
  if (buffer.subarray(0,8).toString('hex') === 'd0cf11e0a1b11ae') {
    const legacy = ['xls','doc','ppt'].find(k => k === ext || TYPES[k] === mime);
    return {ext:legacy || 'bin',mimeType:legacy ? TYPES[legacy] : 'application/octet-stream'};
  }
  if (buffer.subarray(0,6).toString('hex') === '377abcaf271c') return {ext:'7z',mimeType:TYPES['7z']};
  if (buffer.subarray(0,4).toString() === 'Rar!') return {ext:'rar',mimeType:TYPES.rar};
  if (TYPES[ext]) return {ext,mimeType:TYPES[ext]};
  if (allowDocuments && mime === 'application/octet-stream') return {ext:'bin',mimeType:mime};
  return null;
}
function isDeclaredText(header, filename) {
  const ext = extension(filename);
  return ['csv','tsv','txt','json','svg'].includes(ext) || String(header).split(';')[0] === 'image/svg+xml';
}
module.exports = { TYPES, extension, isDocumentUrl, detectExtraFormat, isDeclaredText };
