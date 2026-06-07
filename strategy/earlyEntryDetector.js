class EarlyEntryDetector {
  detect(indicators, oiAnalysis, prev) {
    if (!prev) return null;

    const px = indicators.price;
    const prevPx = prev?.price;
    if (!prevPx) return null;

    const res = oiAnalysis?.walls?.resistanceNearest?.center;
    const sup = oiAnalysis?.walls?.supportNearest?.center;

    const bullishBreak =
      prevPx <= res &&
      px > res &&
      oiAnalysis?.wallPressure?.resistanceWeakening;

    const bearishBreak =
      prevPx >= sup &&
      px < sup &&
      oiAnalysis?.wallPressure?.supportWeakening;

    // --- dynamic delta based on volatility ---
	const range =
	indicators?.recentRange ||
	indicators?.candleRange ||
	(res && sup ? Math.abs(res - sup) : 0) ||
	50;
	
	const effectiveRange = range > 0 ? range : 50;
	
	const deltaOk = Math.abs(px - prevPx) > (effectiveRange * 0.6);
	
	// --- confirms ---
	const confirms = [
	indicators.bias?.bullishEMA,
	indicators.breakout?.priceAboveBB,
	deltaOk
	].filter(Boolean).length;

    if (bullishBreak && confirms >= 2) {
      return {
        direction: 'BUY_CE',
        confidence: 85 + confirms * 5,
        reason: `Resistance ${res} broken`
      };
    }

    if (bearishBreak && confirms >= 2) {
      return {
        direction: 'BUY_PE',
        confidence: 85 + confirms * 5,
        reason: `Support ${sup} broken`
      };
    }

    return null;
  }
}

module.exports = new EarlyEntryDetector();