import { PERSISTED_PROVIDER_SYSTEM } from "../../model/signed-registry-constants";
/** @file provider-types.ts
 * @purpose Local provider authority contracts at the SnoStationMem adapter boundary.
 * @boundary Trusted internal ids in, internal project-agent identity out.
 */

export type ProviderExternalSystem = typeof PERSISTED_PROVIDER_SYSTEM;

export interface ProviderIdentity {
	userId: string;
	projectId: string;
	agentId: string;
}

export interface ProviderAuthorityInput {
	trustedUserId: string;
	externalSystem: ProviderExternalSystem;
	projectKey: string;
	agentKey: string;
}

export interface ProviderMembershipGrantInput extends ProviderAuthorityInput {
	grantor: ProviderIdentity;
}
