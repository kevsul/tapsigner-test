import { BIP32Factory } from 'bip32';
import { Client, AccountBalanceQuery, AccountCreateTransaction, Hbar, TransferTransaction, PublicKey } from "@hashgraph/sdk";
import { CKTapCard } from '../protocol';
import { keccak256 } from '@ethersproject/keccak256';
import retry from 'async-retry';
import * as ecc from 'tiny-secp256k1';

const bip32 = BIP32Factory(ecc);

const ECDSA_OPERATOR = {
  accountId: '0.0.4505363',
  privateKey: '3030020100300706052b8104000a04220420df199ed8fede01935243746af8f8b0d43846150fa9ef2575ebc2ad804d2688e7'
}

async function sendFromOperator(client, operatorId, destinationAccountId, amount) {
  const transaction = await new TransferTransaction()
    .addHbarTransfer(operatorId, amount.negated())
    .addHbarTransfer(destinationAccountId, amount)
    .execute(client);

  // Verify the transaction reached consensus
  const transactionReceipt = await transaction.getReceipt(client);
  console.log("The fund transaction was: " + transactionReceipt.status.toString());
}

const CVC = '123456';

export async function doHedera() {
  const client = Client.forTestnet();
  const operatorAccount = ECDSA_OPERATOR;

  client.setOperator(operatorAccount.accountId, operatorAccount.privateKey);

  const card: CKTapCard = new CKTapCard();
  await card.startNfcSession();
  await card.first_look();

  const path = '0/0';
  const xpub = await card.get_xpub(CVC);
  const subNode = bip32.fromBase58(xpub).derivePath(path);
  const publicKey = subNode.publicKey.toString('hex');

  console.log(`Card publicKey: ${publicKey}`);

  // Create a new account with 1,000 tinybar starting balance
  // const newAccount = await new AccountCreateTransaction()
  //     .setKey(PublicKey.fromStringECDSA(publicKey))
  //     .setInitialBalance(Hbar.fromTinybars(1000))
  //     .execute(client);

  // const getReceipt = await newAccount.getReceipt(client);
  // const address = getReceipt.accountId;
  const address = '0.0.4970281';

  console.log(`Card address: ${address}`);

  const destinationAccountId = address;

  // Fund card account from faucet
  // await sendFromOperator(
  //   client,
  //   operatorAccount.accountId,
  //   destinationAccountId,
  //   Hbar.fromString('2')
  // );

  const accountBalance = await new AccountBalanceQuery()
    .setAccountId(destinationAccountId)
    .execute(client);

  console.log("Destination account balance is: " + accountBalance.hbars);

  const amount = Hbar.fromTinybars('1000000');
  await sendWithTapSigner(client, card, address, publicKey, path, operatorAccount.accountId, amount);

  client.close();
  await card.endNfcSession();
}

async function sendWithTapSigner(client, card, srcAddress, publicKey, path, destination, amount) {
  const transaction = new TransferTransaction()
    .addHbarTransfer(srcAddress, amount.negated()) //Sending account
    .addHbarTransfer(destination, amount); //Receiving account

  //Freeze the transaction for signing
  const freezeTransaction = transaction.freezeWith(client);

  const signedTx = await freezeTransaction.signWith(PublicKey.fromStringECDSA(publicKey), (message: Uint8Array): Promise<Uint8Array> => {
    const hashed = keccak256(`0x${Buffer.from(message).toString('hex')}`);
    const digest = Buffer.from(hashed.startsWith('0x') ? hashed.substring(2) : hashed, 'hex');

    return tapSign(card, digest, path);
  });
  const sendHbar = await signedTx.execute(client);

  // Verify the transaction reached consensus
  const transactionReceipt = await sendHbar.getReceipt(client);
  console.log("The transfer transaction status was: " + transactionReceipt.status.toString());
}

async function tapSign(card, digest, path) {
  return await retry(
    async (bail) => {
      try {
        let signature = await card.sign_digest(CVC, 0, digest, path);
        signature = signature.slice(1); // Remove the recoverable char at pos 0

        return signature;
        // return encode(signature);
      } catch (error) {
        if (error.message.includes('205 on sign: unlucky number')) {
          throw error;
        }

        bail(error);
        return;
      }
    },
    {
      factor: 1,
      minTimeout: 1000,
      retries: 10
    }
  );
}
