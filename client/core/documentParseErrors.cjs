const LIBREOFFICE_DOWNLOAD_URL = 'https://zh-tw.libreoffice.org/download/';
const LIBREOFFICE_REQUIRED_MESSAGE = `.doc和.wps识别，需要安装 LibreOffice、WPS Office 或 Microsoft Word 任意一种本地转换组件（LibreOffice 下载：${LIBREOFFICE_DOWNLOAD_URL}），或者手动将文件转换为.docx格式再上传`;

module.exports = {
  LIBREOFFICE_DOWNLOAD_URL,
  LIBREOFFICE_REQUIRED_MESSAGE,
};
