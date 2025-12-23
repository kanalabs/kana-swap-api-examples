import { NetworkId } from "../../constant";

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";

const CHAIN_TO_CCTP_ID: Record<number, number> = {
  [NetworkId.ethereum]: 0,
  [NetworkId.Avalanche]: 1,
  [NetworkId.Arbitrum]: 3,
  [NetworkId.solana]: 5,
  [NetworkId.base]: 6,
  [NetworkId.polygon]: 7,
  [NetworkId.sui]: 8,
  [NetworkId.aptos]: 9,
};

export async function waitForAttestation(params: {
  sourceChain: NetworkId;
  txHash: string;
}) {
  while (true) {
    const url = `${CIRCLE_ATTESTATION_API}/messages/${CHAIN_TO_CCTP_ID[params.sourceChain]}/${params.txHash}`;
    const res = await fetch(url);
    const json = await res.json();

    const msg = json?.messages?.[0];
    if (msg && msg.attestation !== "PENDING") {
      return {
        messageBytes: msg.message,
        attestationSignature: msg.attestation,
      };
    }

    await new Promise((r) => setTimeout(r, 3000));
  }
}
