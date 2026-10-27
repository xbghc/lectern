import type { Meta, StoryObj } from '@storybook/html-vite';
import { controls, renderPage, type PageArgs } from './render.ts';
export default {
  title: "Android/Pages", render: renderPage, argTypes: controls,
  args: { page: 'app', state: 'populated', tab: 'articles', width: 390, height: 844 },
} satisfies Meta<PageArgs>;
type Story = StoryObj<PageArgs>;
export const Home: Story = { name: "Home · Articles" };
export const EmptyHome: Story = { name: "Home · Empty", args: { state: 'empty' } };
export const Words: Story = { name: "Vocabulary", args: { tab: 'words' } };
export const Review: Story = { name: "Article review", args: { tab: 'articleReview' } };
export const Reader: Story = { name: "Reader", args: { page: 'reader' } };
export const ReaderLoading: Story = { name: "Reader · Classifying", args: { page: 'reader', state: 'loading' } };
export const ReaderError: Story = { name: "Reader · Fetch failed", args: { page: 'reader', state: 'empty' } };
export const Settings: Story = { name: "Settings", args: { page: 'appOptions' } };

export const Classification: Story = { name: "AI article filter", args: { tab: 'classification' } };

export const Books: Story = { name: "Bookshelf · Local EPUB", args: { tab: "books" } };
export const WordReview: Story = { name: "Vocabulary review", args: { tab: "review" } };

export const BookReader: Story = { name: "Reader · EPUB contents", args: { page: 'reader', tab: 'bookReader' } };
export const Statistics: Story = { name: "Reading statistics · Today / 7 days / 30 days", args: { tab: 'stats' } };
export const Chat: Story = { name: "Vocabulary chat", args: { page: 'chat' } };
export const ChatConversation: Story = { name: "Vocabulary chat · In progress", args: { page: 'chat', tab: 'conversation' } };
export const ChatError: Story = { name: "Vocabulary chat · Connection failed", args: { page: 'chat', tab: 'conversation', state: 'error' } };
export const ChatEmpty: Story = { name: "Vocabulary chat · Empty vocabulary", args: { page: 'chat', state: 'empty' } };
