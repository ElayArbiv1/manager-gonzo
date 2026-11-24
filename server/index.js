'use strict';
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';

createApp().listen(port, host, () => {
  console.log(`Gonzo Manager פועל בכתובת http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  if (!process.env.APP_PASSWORD) console.warn('אזהרה: לא הוגדרה סיסמה (APP_PASSWORD). האפליקציה פתוחה לכל מי שמגיע לכתובת.');
});
