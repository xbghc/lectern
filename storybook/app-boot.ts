export { shim } from './runtime.ts';
import { useAppReadingDefaults } from '../src/features/reading/settings.ts';
useAppReadingDefaults();
export const navigation = { beforeLeave: async () => undefined };
export const readerUrl = (url: string) => `read.html?u=${encodeURIComponent(url)}`;
export const isExternal = () => false;
export const go = async (url: string) => { console.info('[Storybook navigation]', url); };
