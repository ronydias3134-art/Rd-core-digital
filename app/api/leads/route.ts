function verifyHmacStrict(
    rawBody: string,
    signatureHeader: string | null,
): boolean {
  const secret = (
      process.env.API_HMAC_SECRET ||
      process.env.APT_HMAC_SECRET ||
      process.env.WEBHOOK_HMAC_SECRET ||
      process.env.WEBHOOK_SECRET ||
      ""
  ).trim();
  if (!secret || !signatureHeader) {
    return false;
  }

  const expectedHex = createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
  const normalized = signatureHeader.replace(/^sha256=/i, "").trim();

  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(normalized, "utf8");

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}
