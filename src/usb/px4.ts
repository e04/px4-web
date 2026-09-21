const CONTROL_OUT = 2;
const CONTROL_IN = 1;
const STREAM_IN = 4;

interface ClaimedInterface {
  configuration: number;
  interfaceNumber: number;
  alternateSetting: number;
  endpoints: USBEndpoint[];
}

export async function claimPx4Interface(device: USBDevice): Promise<ClaimedInterface> {
  for (const configuration of device.configurations) {
    const candidate = findPx4Interface(configuration);
    if (!candidate) continue;
    if (device.configuration?.configurationValue !== configuration.configurationValue)
      await device.selectConfiguration(configuration.configurationValue);
    await device.claimInterface(candidate.interfaceNumber);
    const active = device.configuration?.interfaces.find(
      (entry) => entry.interfaceNumber === candidate.interfaceNumber,
    );
    if (active && active.alternate.alternateSetting !== candidate.alternateSetting)
      await device.selectAlternateInterface(candidate.interfaceNumber, candidate.alternateSetting);
    return { configuration: configuration.configurationValue, ...candidate };
  }
  throw new Error('PX4 bulk endpoints 0x02, 0x81 and 0x84 were not found');
}

function findPx4Interface(
  configuration: USBConfiguration,
): Omit<ClaimedInterface, 'configuration'> | null {
  for (const usbInterface of configuration.interfaces) {
    for (const alternate of usbInterface.alternates) {
      const has = (number: number, direction: 'in' | 'out') =>
        alternate.endpoints.some(
          (endpoint) =>
            endpoint.endpointNumber === number &&
            endpoint.direction === direction &&
            endpoint.type === 'bulk',
        );
      if (has(CONTROL_OUT, 'out') && has(CONTROL_IN, 'in') && has(STREAM_IN, 'in'))
        return {
          interfaceNumber: usbInterface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          // WebUSB exposes these as prototype getters; JSON.stringify otherwise
          // records each native USBEndpoint as {} in the P1 diagnostic report.
          endpoints: alternate.endpoints.map((endpoint) => ({
            endpointNumber: endpoint.endpointNumber,
            direction: endpoint.direction,
            type: endpoint.type,
            packetSize: endpoint.packetSize,
          })),
        };
    }
  }
  return null;
}
