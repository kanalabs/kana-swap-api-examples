/**
 * Fetch Circle CCTP attestation for a source-chain transaction.
 */

import { NetworkId } from "../../constant";

export enum BridgeId {
  native = 0,
  wormhole = 1,
  layerzero = 2,
  cctp = 3,
  cctpV2 = 4,
}

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";

const KANA_CHAIN_TO_CCTP_DOMAIN: Record<number, number> = {
  [NetworkId.ethereum]: 0,
  [NetworkId.Avalanche]: 1,
  [NetworkId.Arbitrum]: 3,
  [NetworkId.solana]: 5,
  [NetworkId.base]: 6,
  [NetworkId.polygon]: 7,
  [NetworkId.sui]: 8,
  [NetworkId.aptos]: 9,
};

export async function fetchAttestation(params: {
  chainId: NetworkId;
  txHash: string;
  bridge: BridgeId.cctp | BridgeId.cctpV2;
  maxRetries?: number;
  pollInterval?: number;
}): Promise<{ messageBytes: string; attestationSignature: string }> {
  const {
    chainId,
    txHash,
    bridge,
    maxRetries = 300,
    pollInterval = 2000,
  } = params;

  let retries = 0;

  while (retries < maxRetries) {
    const url =
      bridge === BridgeId.cctp
        ? `${CIRCLE_ATTESTATION_API}/messages/${KANA_CHAIN_TO_CCTP_DOMAIN[chainId]}/${txHash}`
        : `${CIRCLE_ATTESTATION_API}/v2/messages/${KANA_CHAIN_TO_CCTP_DOMAIN[chainId]}?transactionHash=${txHash}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("Circle API error");

    const data = await res.json();

    if (
      data.messages?.[0] &&
      data.messages[0].attestation !== "PENDING"
    ) {
      return {
        messageBytes: data.messages[0].message,
        attestationSignature: data.messages[0].attestation,
      };
    }

    retries++;
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error("Attestation timeout exceeded");
}
