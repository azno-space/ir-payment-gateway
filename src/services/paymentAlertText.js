'use strict';
// The texts of the payment alerts (HTML, for Bale and Telegram). Pure functions: the sender adds the time.

function sanitizeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 2000);
}

function paymentBlock({ gateway, code, orderId, paymentId }) {
  if (!(gateway && code)) return '';
  let text = `<b>📊 اطلاعات پرداخت:</b>\n• درگاه: <code>${gateway}</code>\n• کد: <code>${code}</code>\n`;
  if (paymentId) text += `• شناسه پرداخت: <code>${paymentId}</code>\n`;
  if (orderId) text += `• شناسه سفارش: <code>${orderId}</code>\n\n`;
  return text;
}

function formatErrorMessage(details, nowIso = new Date().toISOString()) {
  const { title, message, error } = details;
  let text = `<b>🔴 ${title || 'خطا در سیستم پرداخت'}</b>\n\n`;
  text += `<b>پیام:</b>\n${message || 'بدون توضیح'}\n\n`;
  text += paymentBlock(details);
  if (error) text += `<b>⚙️ جزئیات فنی:</b>\n<pre>${sanitizeHtml(error)}</pre>\n`;
  return `${text}<b>⏰ زمان:</b> ${nowIso}\n`;
}

function transactionBlock({ gateway, code, orderId }) {
  if (!gateway) return '';
  let text = `\n<b>📊 تراکنش:</b>\n• درگاه: <code>${gateway}</code>\n`;
  if (code) text += `• RefNum: <code>${code}</code>\n`;
  if (orderId) text += `• سفارش: <code>${orderId}</code>\n`;
  return text;
}

function formatWarningMessage(details, nowIso = new Date().toISOString()) {
  const { title, cancelReason, sepState, sepStatus, gatewayErrorDesc } = details;
  let text = `<b>⚠️ ${title || 'اطلاع‌رسانی پرداخت'}</b>\n\n`;
  text += `<b>علت:</b> ${sanitizeHtml(cancelReason || 'نامشخص')}\n`;
  if (gatewayErrorDesc && gatewayErrorDesc !== cancelReason) text += `<b>شرح خطا:</b> ${sanitizeHtml(gatewayErrorDesc)}\n`;
  if (sepState) text += `• State: <code>${sanitizeHtml(String(sepState))}</code>\n`;
  if (sepStatus) text += `• Status: <code>${sanitizeHtml(String(sepStatus))}</code>\n`;
  text += transactionBlock(details);
  return `${text}\n<b>⏰ زمان:</b> ${nowIso}\n`;
}

module.exports = { formatErrorMessage, formatWarningMessage };
