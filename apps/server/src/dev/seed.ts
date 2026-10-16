import { openLocalServices } from '../runtime.ts'
import { seedSampleProject } from './sample.ts'

// Seeds the local store with the sample project (see sample.ts). Idempotent: an existing sample
// project is left as it is. Uses the same store as the server: KALYTH_DB, or .kalyth/kalyth.db in
// the working directory.
const services = openLocalServices()
const { project, created } = seedSampleProject(services)
process.stderr.write(
  created
    ? `seeded "${project.name}" (${project.id}) at revision ${project.headRevision}\n`
    : `"${project.name}" already exists (${project.id}); nothing to do\n`,
)
