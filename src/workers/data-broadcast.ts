import { decodeTS } from 'web-bml/ts';
import type { TSReader } from 'arib-mmt-tlv-ts/ts/reader.js';

// Reassembles the DSM-CC carousel and SI into web-bml messages for the main-thread BMLBrowser.
let reader: TSReader | undefined;

self.onmessage = (event: MessageEvent) => {
  const { type, bytes, serviceId } = event.data;
  if (type === 'open') {
    reader?.close();
    reader = decodeTS({
      serviceId,
      sendCallback: (message) => {
        // web-bml launches the startup document on the first programInfo, which a NIT ahead
        // of the SDT sends without original_network_id. Documents read it once at load
        // (TX derives its affiliate from it and its main.bml throws without one), so wait
        // for the SDT; every programInfo carries the full merged state.
        if (message.type === 'programInfo' && message.originalNetworkId == null) return;
        self.postMessage(message);
      },
    });
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
