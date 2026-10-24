import { EntityPage } from "../../components/entity-page"

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <EntityPage kind="driver" params={params} />
}
