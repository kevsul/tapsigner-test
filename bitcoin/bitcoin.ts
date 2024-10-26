
import { ECPairFactory } from 'ecpair';
import { CKTapCard } from '../protocol';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import ElectrumClient from 'electrum-client';
import { fundAddress } from './regtest-faucet.js';
import coinSelect from 'coinselect';
import retry from 'async-retry';
import BigNumber from 'bignumber.js';
import reverse from 'buffer-reverse';
import { BIP32Factory } from 'bip32';

const ECPair = ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);
const network = bitcoin.networks.regtest;
const SEQUENCE_RBF_ENABLED = 0xffffffff - 2;
const CVC = '123456';

export function addressToScripthash(address: string, network: bitcoin.Network): string {
  const script = bitcoin.address.toOutputScript(address, network);
  const hash = bitcoin.crypto.sha256(script);
  const reversedHash = Buffer.from(hash.reverse());

  return reversedHash.toString('hex');
}

const electrumConfig = {
  host: '127.0.0.1',
  port: '50001'
};

function segwitBech32ScriptPubKeyToAddress(scriptPubKey: string): string | undefined {
  try {
    const output = Buffer.from(scriptPubKey, 'hex');

    return bitcoin.payments.p2wpkh({
      network,
      output
    }).address;
  } catch (_) {
    return undefined;
  }
}

function pubKeyToAddress(scriptPubKey: string): string | undefined {
  try {
    const output = Buffer.from(scriptPubKey, 'hex');

    return bitcoin.payments.p2pkh({
      network,
      output
    }).address;
  } catch (_) {
    return undefined;
  }
}

function scriptHashToAddress(scriptPubKey: string): string | undefined {
  try {
    const output = Buffer.from(scriptPubKey, 'hex');

    return bitcoin.payments.p2sh({
      network,
      output
    }).address;
  } catch (_) {
    return undefined;
  }
}

function taprootScriptPubKeyToAddress(scriptPubKey: string): string | undefined {
  try {
    const publicKey = Buffer.from(scriptPubKey, 'hex');

    return bitcoin.address.fromOutputScript(publicKey, network);
  } catch (_) {
    return undefined;
  }
}

interface AddressType {
  address: string | undefined;
  type: string | undefined;
}

function getAddressType(script: string): AddressType {
  let address: string | undefined;

  address = segwitBech32ScriptPubKeyToAddress(script);
  if (address) {
    return { address, type: 'witness_v0_keyhash' };
  }

  address = scriptHashToAddress(script);
  if (address) {
    return { address, type: 'scripthash' };
  }

  address = pubKeyToAddress(script);
  if (address) {
    return { address, type: 'pubkeyhash' };
  }

  address = taprootScriptPubKeyToAddress(script);
  if (address) {
    return { address, type: 'witness_v0_scripthash' };
  }

  return { address, type: undefined };
}

async function getAddressBalance(client, address: string): Promise<any> {
  try {
    return await client.blockchainScripthash_getBalance(addressToScripthash(address, network));
  } catch (error) {
    console.log(`Electrum server getAddressBalance error: ${error}`);
  }

  return {
    confirmed: -1,
    unconfirmed: 0
  };
}

const waitForBalance = (client, address: string, targetSats: number, retries = 10) =>
  retry(
    async () => {
      const balance = await getAddressBalance(client, address);

      if (balance.unconfirmed + balance.confirmed < targetSats) {
        throw new Error();
      }
    },
    {
      factor: 1,
      minTimeout: 1000,
      retries
    }
  );

export function txhexToElectrumTransaction(txhex: string) {
  const tx = bitcoin.Transaction.fromHex(txhex);

  const ret = {
    blockhash: '',
    confirmations: 0,
    hash: tx.getHash().toString('hex'),
    hex: txhex,
    locktime: tx.locktime,
    size: Math.ceil(txhex.length / 2),
    time: 0,
    txid: tx.getId(),
    version: tx.version,
    vin: [],
    vout: [],
    vsize: tx.virtualSize(),
    weight: tx.weight()
  };

  for (const input of tx.ins) {
    const txinwitness = input.witness.map(item => item.toString('hex'));

    ret.vin.push({
      scriptSig: { asm: '', hex: input.script.toString('hex') },
      sequence: input.sequence,
      txid: reverse(input.hash).toString('hex'),
      txinwitness,
      vout: input.index
    });
  }

  let i = 0;

  for (const out of tx.outs) {
    const value = new BigNumber(out.value).dividedBy(100000000).toNumber();
    const hex = out.script.toString('hex');
    const { address, type } = getAddressType(hex);

    ret.vout.push({
      // eslint-disable-next-line id-length
      n: i,
      scriptPubKey: {
        address,
        asm: '',
        hex,
        type
      },
      value
    });

    i++;
  }

  return ret;
}

async function getAddressUTXOs(client, address: string): Promise<any[]> {
  const result = await client.blockchainScripthash_listunspent(addressToScripthash(address, network));

  const txhexPromises = result.map(async (unspent: any) => {
    const txhex = await client.blockchainTransaction_get(unspent.tx_hash, true);
    const txDetails = await txhexToElectrumTransaction(txhex);

    return {
      address,
      hash: unspent.tx_hash,
      hex: txDetails.hex,
      txid: txDetails.txid,
      value: unspent.value,
      vout: unspent.tx_pos
    };
  });

  return await Promise.all(txhexPromises);
}

export async function doBitcoin() {
  // const keyPair = ECPair.makeRandom();

  // const { address } = bitcoin.payments.p2wpkh({
  //   network,
  //   pubkey: keyPair.publicKey
  // });

  const card: CKTapCard = new CKTapCard();
  await card.startNfcSession();
  await card.first_look();

  const path = '0/0';
  const { address, publicKey } = await getAddress(card, path);

  await fundAddress(address, '1');
  console.log(`Funded address ${address}`);


  const client = new ElectrumClient(electrumConfig.port, electrumConfig.host);
  await client.connect();

  await waitForBalance(client, address, 100000000);

  const feeRate = Number(1);
  const amount = 5000;
  const toPair = ECPair.makeRandom();
  const { address: toAddress } = bitcoin.payments.p2wpkh({
    network,
    pubkey: toPair.publicKey
  });

  const utxos = await getAddressUTXOs(client, address);

  const result = coinSelect(utxos, [{ address: toAddress, value: amount }], feeRate);

  const { inputs, outputs, fee, error } = result;
  let psbt = new bitcoin.Psbt({ network })

  psbt.addInputs(
    inputs.map(input => {
      const etx = txhexToElectrumTransaction(input.hex);

      return {
        hash: input.txid,
        index: input.vout,
        sequence: SEQUENCE_RBF_ENABLED,
        // witnessScript: redeemScript.output,
        witnessUtxo: {
          script: Buffer.from(etx.vout[input.vout].scriptPubKey.hex, 'hex'),
          value: input.value
        }
      };
    })
  );

  outputs.forEach(output => {
    if (!output.address) {
      output.address = address
    }

    psbt.addOutput({
      address: output.address,
      value: output.value,
    })
  })

  const bitcoinSigner = new TapsignerBitcoinSigner(card, path, publicKey);

  try {
    await psbt.signAllInputsAsync(bitcoinSigner);

    psbt.finalizeAllInputs();

    const tx = psbt.extractTransaction();

    await client.blockchainTransaction_broadcast(tx.toHex());

    const etx = await client.blockchainTransaction_get(tx.getId());

    console.log(etx);
    await waitForBalance(client, toAddress, amount);
    console.log('success');

    return tx.getId();
  } catch (error) {
    console.error(error);
  }

  await client.connect();
  await card.endNfcSession();
}

async function getAddress(card, subpath) {
  const xpub = await card.get_xpub(CVC);
  const subNode = bip32.fromBase58(xpub).derivePath(subpath);

  const { address } = bitcoin.payments.p2wpkh({
    network,
    pubkey: subNode.publicKey
  });

  return { address, publicKey: subNode.publicKey };
}

export class TapsignerBitcoinSigner implements bitcoin.SignerAsync {
  card;
  path: string;
  publicKey: Buffer;

  constructor(card: any, path: string, publicKey: Buffer) {
    this.card = card;
    this.path = path;
    this.publicKey = publicKey;
  }

  async sign(hash: Buffer): Promise<Buffer> {
    return await retry(
      async (bail) => {
        try {
          let signature = await this.card.sign_digest(CVC, 0, hash, this.path);
          signature = signature.slice(1); // Why?

          return signature;
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
}
