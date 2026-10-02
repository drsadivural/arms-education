/**
 * Device-token identity helpers shared by the /devices routes and the push dispatcher.
 * The stored identifier is sha256(lower-case hex token); the token itself is AES-GCM sealed with an AAD that
 * binds it to (organisation, user, hash), so a ciphertext copied to another row cannot be opened.
 */
import { sha256Hex } from "../../auth/crypto";

export const deviceTokenHash = (token: string): Promise<string> => sha256Hex(token.toLowerCase());

export const deviceTokenAad = (orgId: string, userId: string, tokenHash: string): string => `device_token:${orgId}:${userId}:${tokenHash}`;
