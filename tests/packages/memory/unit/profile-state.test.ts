import { afterEach, expect, it, vi } from "vitest";
import { getStateDir } from "../../../../packages/sno-station-mem/src/contract/profile";

afterEach(() => vi.unstubAllEnvs());

it("uses the profile directory supplied by the caller when no explicit override exists", () => {
	vi.stubEnv("SNO_PROFILE_DIR", undefined);
	expect(getStateDir("/tmp/profile-home/.sno-sno-e2e")).toBe("/tmp/profile-home/.sno-sno-e2e");
	expect(getStateDir("/tmp/profile-home/.sno")).toBe("/tmp/profile-home/.sno");
});

it("keeps the explicit Sno directory ahead of the host profile", () => {
	vi.stubEnv("SNO_PROFILE_DIR", "/tmp/explicit-memory-profile");
	expect(getStateDir("/tmp/profile-home/.sno-sno-e2e")).toBe("/tmp/explicit-memory-profile");
});
