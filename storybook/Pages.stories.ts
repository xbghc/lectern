import type { Meta, StoryObj } from '@storybook/html-vite';
import { controls, renderPage, type PageArgs } from './render.ts';
export default {
  title: "Extension/Pages", render: renderPage, argTypes: controls,
  args: { page: 'dashboard', state: 'populated', tab: 'articles', width: 1380, height: 1000 },
} satisfies Meta<PageArgs>;
type Story = StoryObj<PageArgs>;
export const Articles: Story = { name: "Articles · Filters and bulk actions" };
export const Empty: Story = { name: "Articles · Empty", args: { state: 'empty' } };
export const Words: Story = { name: "Vocabulary", args: { tab: 'words' } };
export const WordReview: Story = { name: "Vocabulary review", args: { tab: 'review' } };
export const ArticleReview: Story = { name: "Article review", args: { tab: 'articleReview' } };
export const EmptyReview: Story = { name: "Review · Empty queue", args: { tab: 'review', state: 'empty' } };
export const Settings: Story = { name: "Settings · Reading blocklist", args: { page: 'options' } };
export const NewSettings: Story = { name: "Settings · No model configured", args: { page: 'options', state: 'empty' } };
export const Sidebar: Story = { name: "Side panel · Article vocabulary", args: { page: 'sidepanel', width: 380 } };
export const EmptySidebar: Story = { name: "Side panel · Empty", args: { page: 'sidepanel', width: 380, state: 'empty' } };

export const Classification: Story = { name: "AI article filter · Mixed results", args: { tab: 'classification' } };
export const ClassificationLoading: Story = { name: "AI article filter · In progress", args: { tab: 'classification', state: 'loading' } };
export const ClassificationFailed: Story = { name: "AI article filter · Retry failed", args: { tab: 'classification', state: 'error' } };

export const Statistics: Story = { name: "Reading statistics · Sessions", args: { tab: "stats" } };
