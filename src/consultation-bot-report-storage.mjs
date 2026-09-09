import { encryptSecret, decryptSecret } from './secret-envelope.mjs';

const options = appointmentId => ({
  material: process.env.CONSULTATION_BOT_REPORT_KEY,
  context: `reku-consultation-report:${appointmentId}`,
  errorCode: 'BOT_REPORT_KEY_REQUIRED',
  keyErrorCode: 'BOT_REPORT_KEY_REQUIRED',
  decryptErrorCode: 'BOT_REPORT_DECRYPT_FAILED',
});
export const requireBotReportKey = () => {
  if (typeof process.env.CONSULTATION_BOT_REPORT_KEY !== 'string' || process.env.CONSULTATION_BOT_REPORT_KEY.length < 32)
    throw Object.assign(new Error('BOT_REPORT_KEY_REQUIRED'), { statusCode: 503 });
};
export const encryptBotReport = (pdf, appointmentId) => {
  requireBotReportKey();
  if (!Buffer.isBuffer(pdf) || pdf.length > 2 * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new Error('BOT_REPORT_INVALID');
  return encryptSecret(pdf.toString('base64'), options(appointmentId));
};
export const decryptBotReport = (encrypted, appointmentId) => {
  requireBotReportKey();
  const pdf = Buffer.from(decryptSecret(encrypted, options(appointmentId)), 'base64');
  if (pdf.length > 2 * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('BOT_REPORT_INVALID');
  return pdf;
};
