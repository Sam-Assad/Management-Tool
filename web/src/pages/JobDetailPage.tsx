import { useParams } from 'react-router-dom';
import { useJob } from '../api/hooks';
import JobProgressPanel from '../components/JobProgressPanel';

export default function JobDetailPage() {
  const { jobId } = useParams();
  const id = Number(jobId);
  const { data: job } = useJob(id);
  if (!job) return <p>Loading...</p>;
  return (
    <div>
      <div className="section-label">
        <span className="dot" />
        <span className="label-text">Job run</span>
      </div>
      <h1>Job #{job.id} — {job.kind}</h1>
      <JobProgressPanel jobId={id} />
    </div>
  );
}
