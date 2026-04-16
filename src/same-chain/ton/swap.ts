import axios from "axios";
import "dotenv/config";
import {
  Cell,
  internal,
  SendMode,
  TonClient,
  WalletContractV5R1,
} from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { KANA_API_URL, NetworkId } from "../../constant";

// Constants
const MNEMONIC = process.env.MNEMONIC ?? "";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY ?? "";
const TONCENTER_API_URL =
  process.env.TONCENTER_API_URL ?? "https://toncenter.com/api/v2/jsonRPC";
const XYRA_API_KEY =
  process.env.XYRA_API_KEY ?? "//* YOUR API KEY *//";

const FROM_TOKEN_ADDRESS = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const TO_TOKEN_ADDRESS = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const AMOUNT_IN = "100000000"; // 1 TON
const SLIPPAGE_PERCENTAGE = "0.5";
const SWAP_MODE = "ExactIn";
const MIN_GAS_BALANCE = BigInt("100000000"); // 0.1 TON

interface TonSwapInstruction {
  to: string;
  value: string;
  body: string;
}

interface TonQuote {
  instruction?: TonSwapInstruction;
  amountIn?: string;
  amountOut?: string;
  minimumOutAmount?: string;
  provider?: string;
  priceImpact?: number | string;
}

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": XYRA_API_KEY,
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertMnemonic() {
  if (!MNEMONIC || MNEMONIC.trim().split(/\s+/).length < 12) {
    throw new Error("MNEMONIC is missing or invalid (need 12-24 words)");
  }
}

function assertTonCenterApiKey() {
  if (!TONCENTER_API_KEY) {
    throw new Error("TONCENTER_API_KEY is missing");
  }
}

async function waitForSeqnoIncrease(
  getSeqno: () => Promise<number>,
  currentSeqno: number,
  maxAttempts = 30,
  pollIntervalMs = 3000
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(pollIntervalMs);

    const nextSeqno = await getSeqno().catch(() => currentSeqno);
    if (nextSeqno > currentSeqno) {
      return nextSeqno;
    }

    process.stdout.write(
      `Polling confirmation... ${attempt + 1}/${maxAttempts}\r`
    );
  }

  throw new Error(
    "Swap submitted but confirmation was not observed before timeout"
  );
}

async function resolveSwapInstruction(
  quote: TonQuote,
  walletAddress: string
): Promise<TonSwapInstruction> {
  if (
    quote.instruction?.to &&
    quote.instruction.value &&
    quote.instruction.body
  ) {
    return quote.instruction;
  }

  const response = await axios.post(
    `${KANA_API_URL}/v1/swapInstruction`,
    {
      quote,
      address: walletAddress,
    },
    { headers }
  );

  const instruction = response.data?.data?.instruction ?? response.data?.data;
  if (!instruction?.to || !instruction?.value || !instruction?.body) {
    throw new Error("No TON swap instruction received from Kana");
  }

  return instruction;
}

export const kanaswap = async (): Promise<string> => {
  assertMnemonic();
  assertTonCenterApiKey();

  const mnemonic = MNEMONIC.trim().split(/\s+/);
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV5R1.create({
    publicKey: keyPair.publicKey,
    workchain: 0,
  });
  const walletAddress = wallet.address.toString({
    urlSafe: true,
    bounceable: false,
  });

  const tonClient = new TonClient({
    endpoint: TONCENTER_API_URL,
    apiKey: TONCENTER_API_KEY,
  });
  const contract = tonClient.open(wallet);

  console.log("\n=== TON Same-Chain Swap ===");
  console.log(`Sender: ${walletAddress}`);

  const balance = await tonClient.getBalance(wallet.address);
  console.log(`Balance: ${(Number(balance) / 1e9).toFixed(6)} TON`);

  if (balance < MIN_GAS_BALANCE) {
    throw new Error(
      `Balance too low (${Number(balance) / 1e9} TON). Need at least 0.1 TON for gas.`
    );
  }

  const quoteResponse = await axios.get(`${KANA_API_URL}/v1/swapQuote`, {
    params: {
      inputToken: FROM_TOKEN_ADDRESS,
      outputToken: TO_TOKEN_ADDRESS,
      chain: NetworkId.ton,
      amountIn: AMOUNT_IN,
      swapMode: SWAP_MODE,
      slippage: SLIPPAGE_PERCENTAGE,
      sender: walletAddress,
    },
    headers,
  });

  const quote = quoteResponse.data?.data?.[0] as TonQuote | undefined;
  if (!quote) {
    throw new Error("No swap quote received from Kana");
  }

  console.log(`Provider: ${quote.provider ?? "unknown"}`);
  console.log(`Amount in: ${quote.amountIn ?? AMOUNT_IN}`);
  console.log(`Amount out: ${quote.amountOut ?? "unknown"}`);
  console.log(`Minimum out: ${quote.minimumOutAmount ?? "unknown"}`);
  console.log(`Price impact: ${quote.priceImpact ?? "unknown"}`);

  const instruction = await resolveSwapInstruction(quote, walletAddress);
  console.log(`Instruction to: ${instruction.to}`);
  console.log(`Value: ${instruction.value} nanoTON`);

  const seqno = await contract.getSeqno();
  const messageBody = Cell.fromBase64(instruction.body);
  const msgValue = BigInt(instruction.value);

  console.log(`Submitting transaction with seqno ${seqno}...`);
  await contract.sendTransfer({
    secretKey: keyPair.secretKey,
    seqno,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({
        to: instruction.to,
        value: msgValue,
        body: messageBody,
      }),
    ],
  });

  const confirmedSeqno = await waitForSeqnoIncrease(
    () => contract.getSeqno(),
    seqno
  );
  console.log(`\nConfirmed: ${seqno} -> ${confirmedSeqno}`);

  const transactions = await tonClient.getTransactions(wallet.address, {
    limit: 1,
  });
  const transactionHash = transactions[0]?.hash().toString("hex");

  if (transactionHash) {
    console.log(`Submitted transaction hash: ${transactionHash}`);
    return transactionHash;
  }

  const confirmation = `confirmed:${seqno}`;
  console.log(`Submitted transaction: ${confirmation}`);
  return confirmation;
};

kanaswap().catch((error) => {
  console.error("Error executing TON swap:", error);
  process.exit(1);
});
