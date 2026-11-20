import type { CapacitorConfig } from '@capacitor/cli';

// Folia iOS 容器（Capacitor）配置。构建流程见 .github/workflows/ios-ipa.yml
const config: CapacitorConfig = {
  appId: 'vip.talang.folia',
  appName: 'Folia',
  webDir: 'dist',
  loggingBehavior: 'debug',
  backgroundColor: '#09090b',
  server: {
    iosScheme: 'capacitor',
    hostname: 'localhost',
    cleartext: true,
  },
  ios: {
    contentInset: 'never',
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false,
    backgroundColor: '#09090b',
  },
  plugins: {
    // 音源脚本要直接访问各平台自己的域名，这些域名不回 CORS 预检，WebView 里的 fetch 会被拦下；
    // 打开 CapacitorHttp 后请求走原生，脚本才能在 iOS 上真正取到播放地址。
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 600,
      backgroundColor: '#09090b',
      showSpinner: false,
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'LIGHT',
      backgroundColor: '#09090b',
    },
  },
};

export default config;
