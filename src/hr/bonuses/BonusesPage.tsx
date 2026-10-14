import { useParams } from 'react-router-dom';
import BonusList from './BonusList';
import BonusEditor from './BonusEditor';

/** /hr/bonuses and /hr/bonuses/:id (including /hr/bonuses/new). */
export default function BonusesPage() {
  const { id } = useParams();
  return id ? <BonusEditor key={id} id={id} /> : <BonusList />;
}
