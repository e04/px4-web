import { decodeTS } from 'web-bml/ts';
import type { TSReader } from 'arib-mmt-tlv-ts/ts/reader.js';

// Reassembles the DSM-CC carousel and SI into web-bml messages for the main-thread BMLBrowser.
let reader: TSReader | undefined;

self.onmessage = (event: MessageEvent) => {
  const { type, bytes, serviceId } = event.data;
  if (type === 'open') {
    reader?.close();
    reader = decodeTS({ serviceId, sendCallback: (message) => self.postMessage(message) });
  } else if (type === 'chunk') {
    try {
      reader?.push(new Uint8Array(bytes));
    } catch (error) {
      self.postMessage({ type: 'error', message: String(error) });
    }
  } else if (type === 'close') {
    reader?.close();
    reader = undefined;
  }
};
