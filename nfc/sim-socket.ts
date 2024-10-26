import * as net from 'node:net';
import PromiseSocket, {TimeoutError} from "promise-socket"


const socket = new net.Socket();
const promiseSocket = new PromiseSocket(socket)


function readAll(socket) {
  const stream = socket.stream;
  const bufferArray = [];
  let content = "";
  return new Promise((resolve, reject) => {
      // if (this._errored) {
      //     const err = this._errored;
      //     this._errored = undefined;
      //     return reject(err);
      // }
      if (!stream.readable || stream.closed || stream.destroyed) {
          return resolve(undefined);
      }
      const dataHandler = (chunk) => {
          // if (typeof chunk === "string") {
          //     content += chunk;
          // }
          // else {
          //     bufferArray.push(chunk);
          // }
          removeListeners();
          resolve(chunk);
      };
      const closeHandler = () => {
          removeListeners();
          resolve(undefined);
      };
      const endHandler = () => {
          removeListeners();
          if (bufferArray.length) {
              resolve(Buffer.concat(bufferArray));
          }
          else {
              resolve(content);
          }
      };
      const errorHandler = (err) => {
          // this._errored = undefined;
          removeListeners();
          reject(err);
      };
      const removeListeners = () => {
          stream.removeListener("close", closeHandler);
          stream.removeListener("data", dataHandler);
          stream.removeListener("error", errorHandler);
          stream.removeListener("end", endHandler);
      };
      stream.on("close", closeHandler);
      stream.on("data", dataHandler);
      stream.on("end", endHandler);
      stream.on("error", errorHandler);
      stream.resume();
  });
}

export const simSocket = {
  init: () => {
    return promiseSocket.connect('/tmp/ecard-pipe');
  },

  end: () => {
    return promiseSocket.end();
  },

  transceive: async (msg) => {
    const ret = await promiseSocket.write(Buffer.from(msg));
    return await readAll(promiseSocket);
    // return await promiseSocket.read(128);
  }
};
