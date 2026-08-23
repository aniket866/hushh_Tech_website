import resources from '../../resources/resources'
export default async function getSession(){
    let gcpBackend=resources.config.gcpBackendClient
    await gcpBackend.auth.getSession()
}