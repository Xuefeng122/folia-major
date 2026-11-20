// The two packages the in-app NetEase channel encrypts with. Both are already installed by the
// project's API dependency (crypto-js 4.2.0, node-forge 1.4.0) and declared in package.json, but
// neither ships types through @types: the surface used here is small, so it is written out instead
// of adding a dev dependency that CI would have to install.
declare module 'crypto-js' {
    const CryptoJS: {
        AES: {
            encrypt: (message: unknown, key: unknown, options: Record<string, unknown>) => {
                toString: () => string;
                ciphertext: { toString: () => string };
            };
            decrypt: (ciphertext: unknown, key: unknown, options: Record<string, unknown>) => {
                toString: (encoder: unknown) => string;
            };
        };
        MD5: (message: string) => { toString: () => string };
        enc: { Utf8: { parse: (value: string) => unknown }; Hex: { parse: (value: string) => unknown } };
        mode: { CBC: unknown; ECB: unknown };
        pad: { Pkcs7: unknown };
    };
    export default CryptoJS;
}

declare module 'node-forge' {
    const forge: {
        pki: {
            publicKeyFromPem: (pem: string) => { encrypt: (message: string, scheme: string) => string };
        };
        util: { bytesToHex: (bytes: string) => string };
    };
    export default forge;
}
