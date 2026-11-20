// The package the app draws a QR code with when a platform hands back only the link to scan and no
// picture of it (the in-app NetEase channel does). It ships no types through @types, and the surface
// used here is one call: written out instead of adding a dev dependency CI would have to install.
// Only `toDataURL` is reached, and only from an `import('qrcode')` made when a code has to be drawn,
// so nothing of it is loaded for a first screen or for the desktop channel that gets its picture
// from the API.
declare module 'qrcode' {
    interface QrRenderOptions {
        width?: number;
        margin?: number;
        errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
        color?: { dark?: string; light?: string };
        type?: string;
    }
    export const toDataURL: (text: string, options?: QrRenderOptions) => Promise<string>;
    export const toString: (text: string, options?: QrRenderOptions) => Promise<string>;
    const QRCode: {
        toDataURL: typeof toDataURL;
        toString: typeof toString;
    };
    export default QRCode;
}
