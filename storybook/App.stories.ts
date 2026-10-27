import type { Meta, StoryObj } from '@storybook/html-vite';
import { controls, renderPage, type PageArgs } from './render.ts';
export default {
  title: '安卓/页面', render: renderPage, argTypes: controls,
  args: { page: 'app', state: 'populated', tab: 'articles', width: 390, height: 844 },
} satisfies Meta<PageArgs>;
type Story = StoryObj<PageArgs>;
export const Home: Story = { name: '首页 · 文章' };
export const EmptyHome: Story = { name: '首页 · 空状态', args: { state: 'empty' } };
export const Words: Story = { name: '生词本', args: { tab: 'words' } };
export const Review: Story = { name: '文章回顾', args: { tab: 'articleReview' } };
export const Reader: Story = { name: '阅读器', args: { page: 'reader' } };
export const ReaderLoading: Story = { name: '阅读器 · 判别中', args: { page: 'reader', state: 'loading' } };
export const ReaderError: Story = { name: '阅读器 · 抓取失败', args: { page: 'reader', state: 'empty' } };
export const Settings: Story = { name: '设置', args: { page: 'appOptions' } };

export const Classification: Story = { name: 'LLM 文章筛选', args: { tab: 'classification' } };

export const Books: Story = { name: "书架 · 本地 EPUB", args: { tab: "books" } };
export const WordReview: Story = { name: "生词复习", args: { tab: "review" } };

export const BookReader: Story = { name: '阅读器 · EPUB 目录', args: { page: 'reader', tab: 'bookReader' } };
export const Statistics: Story = { name: '阅读统计 · 今天 / 7 天 / 30 天', args: { tab: 'stats' } };
export const Chat: Story = { name: 'AI 生词对话', args: { page: 'chat' } };
export const ChatConversation: Story = { name: 'AI 生词对话 · 练习中', args: { page: 'chat', tab: 'conversation' } };
export const ChatError: Story = { name: 'AI 生词对话 · 连接失败', args: { page: 'chat', tab: 'conversation', state: 'error' } };
export const ChatEmpty: Story = { name: 'AI 生词对话 · 空生词本', args: { page: 'chat', state: 'empty' } };
