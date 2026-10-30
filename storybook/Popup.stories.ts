import type { Meta, StoryObj } from '@storybook/html-vite';
import { controls, renderPage, type PageArgs } from './render.ts';
export default {
  title: "Extension/Popup", render: renderPage, argTypes: { ...controls, height: { control: false } },
  args: { page: 'popup', state: 'populated', tab: 'current', width: 370, height: 602 },
} satisfies Meta<PageArgs>;
type Story = StoryObj<PageArgs>;
export const Current: Story = { name: "Focus · Today's rhythm" };
export const Translation: Story = { name: "Translation · Page and site", args: { tab: 'translation' } };

export const NonArticle: Story = { name: "Non-article · Translation available", args: { state: 'nonArticle' } };
export const Classifying: Story = { name: "AI classification · In progress", args: { state: 'loading' } };
export const Failed: Story = { name: "AI classification · Failed", args: { state: 'error' } };
export const EmptyHistory: Story = { name: "Focus · Empty", args: { state: 'empty', tab: 'current' } };
