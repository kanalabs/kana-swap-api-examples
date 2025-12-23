import axios from "axios";
import { KANA_API_URL, NetworkId } from "../../constant";

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ------------------ CROSS-CHAIN QUOTE ------------------ */

export async function getCrossChainQuote(params: {
  sourceToken: string;
  targetToken: string;
  amountIn: string;
  sourceChain: NetworkId;
  targetChain: NetworkId;
  slippage: number;
}) {
  const res = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: params.sourceToken,
      targetToken: params.targetToken,
      sourceChain: params.sourceChain,
      targetChain: params.targetChain,
      amountIn: params.amountIn,
      sourceSlippage: params.slippage,
      targetSlippage: params.slippage,
    },
    headers,
  });

  return res.data.data[0];
}

/* ------------------ BUILD CROSS-CHAIN TRANSFER ------------------ */

export async function buildCrossChainInstruction(params: {
  quote: any;
  sourceAddress: string;
  targetAddress: string;
}) {
  const res = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote: params.quote,
      sourceAddress: params.sourceAddress,
      targetAddress: params.targetAddress,
    },
    { headers }
  );

  return res.data.data;
}

/* ------------------ CLAIM ON TARGET CHAIN ------------------ */

export async function claimOnSolana(params: {
  quote: any;
  solanaAddress: string;
  messageBytes: string;
  attestationSignature: string;
}) {
  const res = await axios.post(
    `${KANA_API_URL}/v1/claim`,
    {
      quote: params.quote,
      targetAddress: params.solanaAddress,
      messageBytes: params.messageBytes,
      attestationSignature: params.attestationSignature,
    },
    { headers }
  );

  return res.data.data.claimIx;
}
