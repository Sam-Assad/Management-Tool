import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { api } from '../api/client';

// Old bookmarks/links pointed at /groups/:id. Every server now has its own page, so send them there.
export default function GroupRedirect() {
  const { groupId } = useParams();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ servers?: { id: number }[] }>(`/groups/${groupId}`)
      .then((g) => setTarget(g.servers?.[0] ? `/servers/${g.servers[0].id}` : '/'))
      .catch(() => setTarget('/'));
  }, [groupId]);

  return target ? <Navigate to={target} replace /> : <p>Loading...</p>;
}
