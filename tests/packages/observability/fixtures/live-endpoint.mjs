// Live-endpoint smoke helper for sno-observe integration tests.
//
// Pre-launch: sno.ai is one deployment. CI runs against the in-process fixture
// server only. To smoke-test the real sno.ai endpoint, set
// `SNO_OBSERVE_LIVE_BASE_URL` (e.g. `https://sno.ai`). The SDK bootstraps an
// anonymous machine identity and uses its local machine secret as the bearer.

export function loadLiveBaseUrl() {
	const baseUrl = process.env.SNO_OBSERVE_LIVE_BASE_URL;
	if (baseUrl === undefined || baseUrl.length === 0) {
		return null;
	}
	return baseUrl;
}

export function skipIfNoLiveEndpoint(t) {
	const baseUrl = loadLiveBaseUrl();
	if (baseUrl === null) {
		t.skip("SNO_OBSERVE_LIVE_BASE_URL not set; skipping manual live-endpoint smoke");
		return null;
	}
	return baseUrl;
}
