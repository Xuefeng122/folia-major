// NetEase's own request encryption, done inside the WebView.
//
// Why this exists: the desktop app talks to a real NetEase API server started by Electron, and a
// user can point the app at a remote API base. Neither is available on iOS, where there is no local
// server and (usually) no configured base — and the two ways of asking NetEase directly need the
// payload encrypted. The algorithms below are transcribed from the API package this project already
// ships (@neteasecloudmusicapienhanced/api → util/crypto.js), not from memory: the constants are the
// ones that package encrypts with, and every one of them was verified against the live service.
//
//   weapi — AES-CBC twice (a random 16 character key on the outside, the well-known preset key on the
//           inside) plus RSA for that random key. Used by the account and library routes.
//   eapi  — AES-ECB over "path-md5-digest-body", sent to interfacepc.music.163.com. Used by the newer
//           app routes (search, playback URLs, lyrics, QR login) that answer 20001 on the plain web API.
import CryptoJS from 'crypto-js';
import forge from 'node-forge';

export const NETEASE_WEB_DOMAIN = 'https://music.163.com';
export const NETEASE_EAPI_DOMAIN = 'https://interfacepc.music.163.com';

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const EAPI_KEY = 'e82ckenh8dichen8';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const WEAPI_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

// The app answers differently to the two clients it serves: the web client (cookie-only routes) and
// the phone client (eapi routes). Sending the phone user agent with eapi is what makes those routes
// answer with the phone's payload instead of `{"code":400}`.
export const UA_IOS = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';
export const UA_PC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const md5Hex = (text: string) => CryptoJS.MD5(text).toString();

const aesEncrypt = (text: string, mode: 'cbc' | 'ecb', key: string, iv: string, format: 'base64' | 'hex') => {
    const encrypted = CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(text), CryptoJS.enc.Utf8.parse(key), {
        iv: CryptoJS.enc.Utf8.parse(iv),
        mode: mode === 'cbc' ? CryptoJS.mode.CBC : CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7,
    });
    return format === 'base64' ? encrypted.toString() : encrypted.ciphertext.toString().toUpperCase();
};

let cachedPublicKey: { encrypt: (message: string, scheme: string) => string } | null = null;
const rsaEncryptHex = (text: string) => {
    if (!cachedPublicKey) {
        cachedPublicKey = forge.pki.publicKeyFromPem(WEAPI_PUBLIC_KEY);
    }
    return forge.util.bytesToHex(cachedPublicKey.encrypt(text, 'NONE'));
};

const randomKey = () => {
    const bytes = new Uint8Array(16);
    const webCrypto = typeof crypto !== 'undefined' ? crypto : undefined;
    if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
        webCrypto.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, byte => BASE62.charAt(byte % 62)).join('');
};

// The random AES key is reversed before RSA: the server reverses it back before decrypting.
export const buildWeapiPayload = (payload: Record<string, unknown>) => {
    const secretKey = randomKey();
    const inner = aesEncrypt(JSON.stringify(payload), 'cbc', PRESET_KEY, IV, 'base64');
    return {
        params: aesEncrypt(inner, 'cbc', secretKey, IV, 'base64'),
        encSecKey: rsaEncryptHex(secretKey.split('').reverse().join('')),
    };
};

// "path-md5(body)-body-md5(body)" — the digest ties the body to the path, so a body replayed on
// another route is rejected.
export const buildEapiPayload = (path: string, payload: Record<string, unknown>) => {
    const text = JSON.stringify(payload);
    const digest = md5Hex(`nobody${path}use${text}md5forencrypt`);
    const message = `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
    return { params: aesEncrypt(message, 'ecb', EAPI_KEY, '', 'hex') };
};

// Some eapi answers arrive as a hex ciphertext body instead of JSON.
export const decryptEapiBody = (cipherHex: string) => {
    try {
        return CryptoJS.AES.decrypt({ ciphertext: CryptoJS.enc.Hex.parse(cipherHex.replace(/\s+/g, '')) }, CryptoJS.enc.Utf8.parse(EAPI_KEY), {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7,
        }).toString(CryptoJS.enc.Utf8);
    } catch {
        return '';
    }
};
