import axios from "axios";
import "dotenv/config";
import { Account, AccountAddress, Aptos, AptosConfig, Ed25519PrivateKey, Network, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { KANA_API_URL, NetworkId } from "../../constant";

const config = new AptosConfig({ network: Network.MAINNET });
const aptos = new Aptos(config);

// Constants
const APTOS_PRIVATEKEY = "YOUR_APTOS_PRIVATE_KEY"
const APTOS_ADDRESS = "YOUR_APTOS_WALLET_ADDRESS"

const FROM_TOKEN_ADDRESS = "0x1::aptos_coin::AptosCoin"
const TO_TOKEN_ADDRESS = "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b"

const AMOUNT_IN = 200000000 // 2 APT

const SLIPPAGE_PERCENTAGE = 0.5


const sender = Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(PrivateKey.formatPrivateKey(APTOS_PRIVATEKEY, PrivateKeyVariants.Ed25519)), // Aptos Privatekey  
    address:  AccountAddress.from(APTOS_ADDRESS), // Aptos Address
    legacy: true,
  });
  
export const kanaswap = async () => {
    const response = await axios.get(`${KANA_API_URL}/v1/swapQuote`, {
        params: {
            inputToken: FROM_TOKEN_ADDRESS, //APT
            outputToken: TO_TOKEN_ADDRESS, //USDt
            chain: NetworkId.aptos, //Aptos 
            amountIn: AMOUNT_IN,// amonut * token decimal eg: 2*100000000
            slippage: SLIPPAGE_PERCENTAGE, //0.5%
            sender:  sender.accountAddress.toString(), //sender address 
            swapMode: "exactOut" // exactOut or exactIn, default is exactIn
        },
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': '//* YOUR API KEY *//',
        },
      });

    // 1. Build
    console.log("\n=== 1. Building the transaction ===\n");
    const transaction = await aptos.transaction.build.simple({
        sender: sender.accountAddress,
        data: {
            function: response.data?.data[0].instruction?.function,
            typeArguments: response.data?.data[0].instruction?.type_arguments,
            functionArguments: response.data?.data[0].instruction?.arguments,        },
    });
    console.log("Built the transaction!")

    // 2. Simulate (Optional)
    console.log("\n === 2. Simulating Response (Optional) === \n")
    const [userTransactionResponse] = await aptos.transaction.simulate.simple({
        signerPublicKey: sender.publicKey,
        transaction,
    });
    console.log(userTransactionResponse)

    // 3. Sign & submit
    console.log("\n=== 3. Signing&Submittingtransaction ===\n");
    const submittedTransaction = await aptos.transaction.signAndSubmitTransaction({
        signer: sender,
        transaction,
    });
    console.log(`Submitted transaction hash: ${submittedTransaction.hash}`);

    // 5. Wait for results
    console.log("\n=== 5. Waiting for result of transaction ===\n");
    const executedTransaction = await aptos.waitForTransaction({ transactionHash: submittedTransaction.hash });
    console.log(executedTransaction)
};

kanaswap()