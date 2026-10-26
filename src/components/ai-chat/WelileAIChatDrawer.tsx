import { AssistantChatSurface, type AssistantChatSurfaceProps } from './AssistantChatSurface';

/** Deep-linked /ai conversations use the same public-and-personal assistant surface. */
export default function WelileAIChatDrawer(props: AssistantChatSurfaceProps) {
  return <AssistantChatSurface {...props} />;
}
