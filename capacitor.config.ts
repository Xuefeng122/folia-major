import type { CapacitorConfig } from '@capacitor/cli';

// Folia iOS 容器（Capacitor）配置。构建流程见 .github/workflows/ios-ipa.yml
const config: CapacitorConfig = {
  appId: 'com.xuefeng122.folia',
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
