import HRPlaceholderPage from './HRPlaceholderPage';
import TasksList from '../components/TasksList';

export default function TasksPage() {
  return (
    <HRPlaceholderPage heading="Tasks" subtitle="Work assigned across departments">
      <TasksList />
    </HRPlaceholderPage>
  );
}
