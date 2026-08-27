const crypto = require("crypto");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomUUID() {
  return crypto.randomUUID();
}

function randomUUIDHex() {
  return crypto.randomUUID().replace(/-/g, "").toUpperCase();
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randArr(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getRandomSubstring(str, min = 20, max = 32) {
  const len = str.length;
  if (len <= min) return str;
  return str.substring(0, randInt(min, max));
}

// MM/DD/YYYY（斜杠格式，用于 dailySetItems 比对）
function getDateSlash() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

// 英文星期（用于 Evergreen 活动过滤）
function getDayEn() {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[new Date().getDay()];
}

function isJSON(s) {
  try {
    const j = JSON.parse(s);
    return Array.isArray(j) || (typeof j === "object" && j !== null);
  } catch {
    return false;
  }
}

module.exports = { sleep, randomUUID, randomUUIDHex, randInt, randArr, getRandomSubstring, getDateSlash, getDayEn, isJSON };
