import { ECPairFactory } from 'ecpair';
import { CKTapCard } from '../protocol';
import { BN } from 'bn.js';
import { deriveAddress } from 'ripple-keypairs'
import { BIP32Factory } from 'bip32';
import * as bip39 from 'bip39';
import * as ecc from 'tiny-secp256k1';
import * as bip66 from 'bip66';
import xrpl from "xrpl";
import retry from 'async-retry';
import hashjs from 'hash.js';
import elliptic from 'elliptic';
import Signature from 'elliptic/lib/elliptic/ec/signature';

const ec = new elliptic.ec('secp256k1');

const ECPair = ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);

const FAUCET_SEED = 'sEdSkBPmveAan7YoHHCu1Txp4yLHYoi';
const FAUCET_SEED_2 = 'sEdT2ykrUt5tYyE3H79SPgi7d34zEqj';


const seedPhrase = 'tide culture tired edit chef alcohol task zebra public sing under pledge';
const seed = bip39.mnemonicToSeedSync(seedPhrase); // eslint-disable-line no-sync
const rootNode = bip32.fromSeed(seed);


function verifySignature(signature: string, message: string, publicKey: string) {
  const pubkey = ec.keyFromPublic(publicKey, 'hex');
  const msgHash = hash(hexToBytes(message));

  let sig;

  try {
    // Try construct a Signature from a DER encoded signature
    sig = new Signature(signature, 'hex');
  } catch (error) {
    // Not a DER encoded signature, try raw
    const sigArray = Buffer.from(signature, 'hex');

    sig = new Signature({
      // eslint-disable-next-line id-length
      r: sigArray.subarray(0, 32),
      // eslint-disable-next-line id-length
      s: sigArray.subarray(32, 64)
    });
  }

  return pubkey.verify(msgHash, sig);
}

function hash(message: string | number[]): Buffer {
  const hash = hashjs.sha512().update(message).digest().slice(0, 32);

  // return Buffer.from(hash).toString('hex');
  return Buffer.from(hash);
}

function hexToBytes(str: string) {
  if (str.length % 2 !== 0) {
    throw new Error('Length of message is not % 2');
  }

  // Special-case length zero to return [].
  // BN.toArray intentionally returns [0] rather than [] for length zero,
  // which may make sense for BigNum data, but not for byte strings.

  return str.length === 0 ? [] : new BN(str, 16).toArray(null, str.length / 2);
}

async function getBalance(client, account) {
  const accountInfo = await client.request({
    "command": "account_info",
    "account": account,
    "ledger_index": "validated"
  });

  return Number(accountInfo.result.account_data.Balance)
}

async function send(client, wallet, destination, sendAmount) {
  const prepared = await client.autofill({
    "TransactionType": "Payment",
    "Account": wallet.address,
    "Amount": xrpl.xrpToDrops(sendAmount),
    "Destination": destination,
    "DestinationTag": 12345
  })
  const signed = wallet.sign(prepared)
  return client.submitAndWait(signed.tx_blob)
}

const ZERO = Buffer.alloc(1, 0);
function toDER(x: Buffer): Buffer {
  let i = 0;
  while (x[i] === 0) ++i;
  if (i === x.length) return ZERO;
  x = x.slice(i);
  if (x[0] & 0x80) return Buffer.concat([ZERO, x], 1 + x.length);
  return x;
}

export function encode(signature: Buffer): Buffer {
  const r = toDER(signature.slice(0, 32));
  const s = toDER(signature.slice(32, 64));

  return Buffer.from(bip66.encode(r, s));
}

async function ecSign(rootNode, digest, path) {
  const subNode = rootNode.derivePath(path);
  // const { privateKey } = rootNode.derivePath(path);
  const signature = ec.sign(digest, subNode.privateKey, {
    canonical: true
  });


  const publicKey = subNode.publicKey.toString('hex');
  const address = deriveAddress(publicKey);

  return Buffer.from(signature.toDER());
}

async function tapSign(card, digest, path) {
  return await retry(
    async (bail) => {
      try {
        let signature = await card.sign_digest(CVC, 0, digest, path);
        signature = signature.slice(1); // Remove the recoverable char at pos 0

        return encode(signature);
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

async function sendWithTapSigner(client, card, srcAddress, publicKey, path, destination, sendAmount) {
  const prepared: xrpl.Transaction = await client.autofill({
    "TransactionType": "Payment",
    "Account": srcAddress,
    "Amount": xrpl.xrpToDrops(sendAmount),
    "Destination": destination,
    "DestinationTag": 12345,
    "SigningPubKey": publicKey
  })

  const encodedTransaction = xrpl.encodeForSigning(prepared);
  const digest = hash(hexToBytes(encodedTransaction));

  // const signature = await ecSign(rootNode, digest, path);
  const signature = await tapSign(card, digest, path);

  const ver = verifySignature(signature, encodedTransaction, publicKey);
  if (!ver) {
    throw new Error('Signature not verified!');
  }

  prepared.TxnSignature = signature.toString('hex');

  return client.submitAndWait(prepared);
}

const CVC = '123456';

async function getAddress(card, subpath) {
  const xpub = await card.get_xpub(CVC);
  const subNode = bip32.fromBase58(xpub).derivePath(subpath);
  const publicKey = subNode.publicKey.toString('hex');
  const address = deriveAddress(publicKey);

  return { address, publicKey };
}

async function getAddressEC(rootNode, subpath) {
  const subNode = rootNode.derivePath(subpath);
  const publicKey = subNode.publicKey.toString('hex');
  const address = deriveAddress(publicKey);

  return { address, publicKey };
}

export async function doXrpl() {
  // const client = new xrpl.Client("wss://xrplcluster.com/")
  // const client = new xrpl.Client("wss://dawn-convincing-glitter.xrp-testnet.quiknode.pro/f3a7a8aaa3ff95849dea21797e0c492340843ef7/")
  const client = new xrpl.Client("wss://s.altnet.rippletest.net:51233/")
  await client.connect()

  // const wallet = xrpl.Wallet.fromSeed(FAUCET_SEED);
  const wallet = xrpl.Wallet.fromSeed(FAUCET_SEED , { algorithm: xrpl.ECDSA});
  console.log(`Faucet address: ${wallet.address}`);

  const card: CKTapCard = new CKTapCard();
  await card.startNfcSession();
  await card.first_look();

  const path = '0/0';
  const { address, publicKey } = await getAddress(card, path);
  // const { address, publicKey } = await getAddressEC(rootNode, path);
  console.log(`Card address: ${address}`);
  console.log(`Card publicKey: ${publicKey}`);

  // Fund the card address from the faucet.
  // await send(client, wallet, address, 100);

  // Send some back
  await sendWithTapSigner(client, card, address, publicKey, path, wallet.address, 10);

  client.disconnect();
  await card.endNfcSession();
}
