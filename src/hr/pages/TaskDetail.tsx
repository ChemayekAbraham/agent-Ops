import HRPlaceholderPage from './HRPlaceholderPage';
import TaskDetailView from '../components/TaskDetail';

export default function TaskDetailPage() {
  return (
    <HRPlaceholderPage heading="Task" subtitle="Task detail and activity timeline">
      <TaskDetailView />
    </HRPlaceholderPage>
  );
}
