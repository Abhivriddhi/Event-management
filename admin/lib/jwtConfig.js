export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  return secret && Buffer.byteLength(secret) >= 32 ? secret : null;
}
