import type { Meta, StoryObj } from '@storybook/html-vite';
import { controls, renderPage, type PageArgs } from './render.ts';
export default {
  title: '扩展/弹出面板', render: renderPage, argTypes: controls,
  args: { page: 'popup', state: 'populated', tab: 'current', width: 380, height: 760 },
} satisfies Meta<PageArgs>;
type Story = StoryObj<PageArgs>;
export const Current: Story = { name: '专注 · 今日节奏' };
export const Translation: Story = { name: '翻译 · 本页与站点', args: { tab: 'translation' } };

export const NonArticle: Story = { name: '非文章 · 翻译可用', args: { state: 'nonArticle' } };
export const Classifying: Story = { name: 'LLM 判别中', args: { state: 'loading' } };
export const Failed: Story = { name: 'LLM 判别失败', args: { state: 'error' } };
export const EmptyHistory: Story = { name: '专注 · 空记录', args: { state: 'empty', tab: 'current' } };
