import { createHash } from 'node:crypto';

export const legacyApplicantKey = ({ applicantRole, normalizedName }) =>
  `${applicantRole}#${normalizedName}`;

export const applicantKeyFor = ({
  activityId,
  applicantRole,
  normalizedName,
  password
}) => {
  const fingerprint = createHash('sha256')
    .update([activityId, applicantRole, normalizedName, password].join('\u0000'))
    .digest('hex')
    .slice(0, 32);

  return `${legacyApplicantKey({ applicantRole, normalizedName })}#${fingerprint}`;
};
