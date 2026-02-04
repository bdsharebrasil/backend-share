import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { FileText, Fuel, Wrench, Plane, Download, Upload, FileCheck, Eye, Send, Trash } from "lucide-react";
import { previewPDFForPrint, TravelReport as TravelReportPDF, TravelExpense } from "@/lib/travelReportPDF";
import { FileUploadDialog } from "./FileUploadDialog";
import { ContractUploadDialog } from "./ContractUploadDialog";
import { FinancialHistoryTab } from "./FinancialHistoryTab";
import { EnvioDespesaTab } from "./EnvioDespesaTab";
import { toast } from "sonner";

export interface ClientDataTabsProps {
  clientId: string;
  clientName: string;
  aircraftId: string;
  aircraftRegistration: string;
  isAdmin?: boolean;
}

interface TravelReport {
  id: string;
  report_number: string;
  created_at: string;
  observations?: string;
  total_amount?: number;
  payment_term?: string;
  status?: string;
  client_name?: string;
  aircraft_registration?: string;
  crew_member_name?: string;
  crew_member_name_2?: string;
  destination?: string;
  start_date?: string;
  end_date?: string;
  expenses?: any;
  total_fuel?: number;
  total_lodging?: number;
  total_food?: number;
  total_transport?: number;
  total_other?: number;
  total_crew?: number;
  total_crew1?: number;
  total_crew2?: number;
  total_client?: number;
  total_sharebrasil?: number;
}


export function ClientDataTabs({ clientId, clientName, aircraftId, aircraftRegistration, isAdmin = false }: ClientDataTabsProps) {
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [contractUploadDialogOpen, setContractUploadDialogOpen] = useState(false);
  const [files, setFiles] = useState<any[]>([]);
  const [contracts, setContracts] = useState<any[]>([]);
  const [logbookEntries, setLogbookEntries] = useState<any[]>([]);
  const [fuelRecords, setFuelRecords] = useState<any[]>([]);
  const [ctmTracking, setCtmTracking] = useState<any[]>([]);
  const [travelReports, setTravelReports] = useState<TravelReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [partners, setPartners] = useState<any[]>([]);
  const [activeClientId, setActiveClientId] = useState<string>(clientId);
  const [fornecedoresShare, setFornecedoresShare] = useState<any[]>([]);

  // Carregador de dados principal (carrega dados do cliente ativo)
  useEffect(() => {
    setActiveClientId(clientId);
  }, [clientId]);

  useEffect(() => {
    // Buscar cotistas/partners da aeronave
    const loadPartners = async () => {
      if (!aircraftId) return;
      try {
        const { data } = await supabase
          .from('aircraft_shareholders')
          .select('*, client:client_id(id, company_name)')
          .eq('aircraft_id', aircraftId)
          .order('share_percentage', { ascending: false });

        const partnerList = (data || []).map((p: any) => ({
          client_id: p.client_id,
          company_name: p.client?.company_name || p.client_name || p.partner_name || p.client_id,
          share_percentage: p.share_percentage || 0,
        }));

        // Ensure the primary client is included
        if (!partnerList.find((p: any) => p.client_id === clientId)) {
          partnerList.unshift({ client_id: clientId, company_name: clientName, share_percentage: 100 });
        }

        setPartners(partnerList);
        // default to the provided clientId if present
        setActiveClientId(clientId);
      } catch (error) {
        console.error('Error loading partners:', error);
      }
    };

    loadPartners();
  }, [aircraftId, clientId, clientName]);

  // Buscar fornecedores favoritos categoria 'share'
  useEffect(() => {
    const loadFornecedoresShare = async () => {
      try {
        const { data, error } = await supabase
          .from('fornecedores_favoritos')
          .select('nome_completo')
          .eq('categoria', 'share');
        if (error) throw error;
        setFornecedoresShare(data || []);
      } catch (err) {
        console.error('Erro ao buscar fornecedores favoritos:', err);
      }
    };
    loadFornecedoresShare();
  }, []);

  const loadData = async (forClientId: string) => {
    try {
      setLoading(true);

      // Load files (for bank reconciliation - Notas Fiscais e Boletos)
      const { data: filesData } = await supabase
        .from('client_portal_files')
        .select('*')
        .eq('client_id', forClientId)
        .order('created_at', { ascending: false });

      // Load contracts
      const { data: contractsData } = await supabase
        .from('client_contracts')
        .select('*')
        .eq('client_id', forClientId)
        .order('created_at', { ascending: false });

      // Load logbook entries
      const { data: logbookData } = await supabase
        .from('logbook_entries')
        .select('*, aircraft:aircraft_id(registration)')
        .eq('aircraft_id', aircraftId)
        .eq('client_id', forClientId)
        .order('entry_date', { ascending: false })
        .limit(10);

      // Load fuel records
      const { data: fuelData } = await supabase
        .from('abastecimentos')
        .select('*, aeronave:aeronave_id(registration)')
        .eq('aeronave_id', aircraftId)
        .eq('client_id', forClientId)
        .order('data', { ascending: false })
        .limit(10);

      // Load CTM tracking
      const { data: ctmData } = await supabase
        .from('ctm_tracking')
        .select('*, aircraft:aircraft_id(registration)')
        .eq('aircraft_id', aircraftId)
        .eq('client_id', forClientId)
        .order('created_at', { ascending: false });

      // Load travel reports for specific aircraft
      const { data: reportsData } = await supabase
        .from('travel_expense_reports')
        .select('*')
        .eq('client_id', forClientId)
        .eq('aircraft_id', aircraftId)
        .order('created_at', { ascending: false })
        .limit(10);

      setFiles(filesData || []);
      setContracts(contractsData || []);
      setLogbookEntries(logbookData || []);
      setFuelRecords(fuelData || []);
      setCtmTracking(ctmData || []);
      setTravelReports(reportsData || []);
    } catch (error) {
      console.error('Error loading client data:', error);
    } finally {
      setLoading(false);
    }
  };

  const downloadFile = async (filePath: string, bucket: string = 'client-documents') => {
    try {
      const { data, error } = await supabase.storage
        .from(bucket)
        .download(filePath);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = filePath.split('/').pop() || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading file:', error);
      toast.error('Erro ao baixar arquivo');
    }
  };

  const deleteContract = async (contractId: string, filePath: string) => {
    try {
      // Delete from storage
      const { error: storageError } = await supabase.storage
        .from('client-documents')
        .remove([filePath]);

      if (storageError) throw storageError;
      // Delete from database
      const { error: dbError } = await supabase
        .from('client_contracts')
        .delete()
        .eq('id', contractId);

      if (dbError) throw dbError;

      setContracts(prev => prev.filter(c => c.id !== contractId));
      toast.success('Contrato removido com sucesso');
    } catch (error) {
      console.error('Error deleting contract:', error);
      toast.error('Erro ao remover contrato');
    }
  };

  return (
    <>
      <Tabs defaultValue="files" className="w-full">
        <TabsList>
          <TabsTrigger value="files">Arquivos</TabsTrigger>
          <TabsTrigger value="contracts">Contratos</TabsTrigger>
          <TabsTrigger value="logbook">Logbook</TabsTrigger>
          <TabsTrigger value="fuel">Abastecimentos</TabsTrigger>
          <TabsTrigger value="ctm">CTM</TabsTrigger>
          <TabsTrigger value="travel-reports">Relatórios de Viagem</TabsTrigger>
          <TabsTrigger value="envio-despesa">Envio de Despesa</TabsTrigger>
        </TabsList>

        <TabsContent value="files" className="space-y-4">
          <Card className="bg-gradient-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Upload className="h-5 w-5 text-primary" />
                Upload de Arquivos
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Envie seus arquivos para o portal
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                onClick={() => setUploadDialogOpen(true)}
                className="w-full"
                size="lg"
              >
                <Upload className="h-4 w-4 mr-2" />
                Enviar Arquivos
              </Button>

              {files.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">Nenhum arquivo enviado ainda</p>
              ) : (
                <div className="space-y-2">
                  {files.map((file) => (
                    <div
                      key={file.id}
                      className="p-4 bg-muted/50 rounded-lg border border-border flex justify-between items-center"
                    >
                      <div className="flex-1">
                        <p className="font-medium text-foreground">{file.file_name}</p>
                        <p className="text-sm text-muted-foreground">
                          Enviado em: {new Date(file.created_at).toLocaleDateString('pt-BR')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadFile(file.file_path)}
                        >
                          <Download className="h-4 w-4" />
                          Baixar
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="contracts" className="space-y-4">
          <Card className="bg-gradient-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <FileText className="h-5 w-5 text-primary" />
                Contratos
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Gerencie os contratos da sua empresa
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                onClick={() => setContractUploadDialogOpen(true)}
                className="w-full"
                size="lg"
              >
                <Upload className="h-4 w-4 mr-2" />
                Enviar Contrato
              </Button>

              {contracts.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">Nenhum contrato encontrado</p>
              ) : (
                <div className="space-y-2">
                  {contracts.map((contract) => (
                    <div
                      key={contract.id}
                      className="p-4 bg-muted/50 rounded-lg border border-border flex justify-between items-center"
                    >
                      <div className="flex-1">
                        <p className="font-medium text-foreground">{contract.file_name}</p>
                        <p className="text-sm text-muted-foreground">
                          Enviado em: {new Date(contract.created_at).toLocaleDateString('pt-BR')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadFile(contract.file_path)}
                        >
                          <Download className="h-4 w-4" />
                          Baixar
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => deleteContract(contract.id, contract.file_path)}
                        >
                          <Trash className="h-4 w-4" />
                          Remover
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logbook" className="space-y-4">
          <Card className="bg-gradient-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Plane className="h-5 w-5 text-primary" />
                Logbook
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Registre e acompanhe os voos da aeronave
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                onClick={() => setUploadDialogOpen(true)}
                className="w-full"
                size="lg"
              >
                <Upload className="h-4 w-4 mr-2" />
                Enviar Registro de Voo
              </Button>

              {logbookEntries.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">Nenhum registro de voo encontrado</p>
              ) : (
                <div className="space-y-2">
                  {logbookEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className="p-4 bg-muted/50 rounded-lg border border-border flex justify-between items-center"
                    >
                      <div className="flex-1">
                        <p className="font-medium text-foreground">{entry.flight_number}</p>
                        <p className="text-sm text-muted-foreground">
                          Data: {new Date(entry.entry_date).toLocaleDateString('pt-BR')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadFile(entry.file_path)}
                        >
                          <Download className="h-4 w-4" />
                          Baixar
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="fuel" className="space-y-4">
          <Card className="bg-gradient-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Fuel className="h-5 w-5 text-primary" />
                Abastecimentos
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Registre e acompanhe os abastecimentos da aeronave
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                onClick={() => setUploadDialogOpen(true)}
                className="w-full"
                size="lg"
              >
                <Upload className="h-4 w-4 mr-2" />
                Enviar Registro de Abastecimento
              </Button>

              {fuelRecords.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">Nenhum registro de abastecimento encontrado</p>
              ) : (
                <div className="space-y-2">
                  {fuelRecords.map((record) => (
                    <div
                      key={record.id}
                      className="p-4 bg-muted/50 rounded-lg border border-border flex justify-between items-center"
                    >
                      <div className="flex-1">
                        <p className="font-medium text-foreground">{record.registration}</p>
                        <p className="text-sm text-muted-foreground">
                          Data: {new Date(record.data).toLocaleDateString('pt-BR')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadFile(record.file_path)}
                        >
                          <Download className="h-4 w-4" />
                          Baixar
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ctm" className="space-y-4">
          <Card className="bg-gradient-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Wrench className="h-5 w-5 text-primary" />
                Gestão de CTM
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Controle de manutenção
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {ctmTracking.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">Nenhum item de CTM registrado</p>
              ) : (
                ctmTracking.map((item) => (
                  <div
                    key={item.id}
                    className="p-4 bg-muted/50 rounded-lg border border-border"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-medium text-foreground">{item.item_name}</p>
                        <p className="text-sm text-muted-foreground">Tipo: {item.control_type}</p>
                      </div>
                      <Badge variant="outline" className="bg-primary/20 text-primary">
                        {item.remaining_hours}h restantes
                      </Badge>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="travel-reports" className="space-y-4">
          <Card className="bg-gradient-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <FileText className="h-5 w-5 text-primary" />
                Relatórios de Viagem
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Relatórios emitidos com status e prazo de pagamento
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {travelReports.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">Nenhum relatório disponível</p>
              ) : (
                travelReports.map((report) => {
                  // Preparar dados para o PDF
                  const handleViewPDF = async () => {
                    try {
                      // Parse expenses
                      let expenses: TravelExpense[] = [];
                      if (report.expenses) {
                        try {
                          const parsed = typeof report.expenses === 'string'
                            ? JSON.parse(report.expenses)
                            : report.expenses;
                          expenses = parsed.map((e: any) => ({
                            categoria: e.category || e.categoria || 'Outros',
                            descricao: e.description || e.descricao || '',
                            valor: Number(e.amount || e.valor) || 0,
                            pago_por: e.paid_by || e.pago_por || 'Cliente',
                            comprovante_url: e.receipt_url || e.comprovante_url
                          }));
                        } catch (err) {
                          console.error('Erro ao parsear despesas:', err);
                        }
                      }

                      const pdfReport: TravelReportPDF = {
                        numero: report.report_number,
                        cliente_nome: report.client_name || 'Cliente',
                        aeronave: report.aircraft_registration || 'N/A',
                        tripulante: report.crew_member_name || 'N/A',
                        tripulante2: report.crew_member_name_2,
                        destino: report.destination || 'N/A',
                        data_inicio: report.start_date || report.created_at,
                        data_fim: report.end_date || report.created_at,
                        observacoes: report.observations,
                        despesas: expenses,
                        total_combustivel: report.total_fuel || 0,
                        total_hospedagem: report.total_lodging || 0,
                        total_alimentacao: report.total_food || 0,
                        total_transporte: report.total_transport || 0,
                        total_outros: report.total_other || 0,
                        total_tripulante: report.total_crew || 0,
                        total_tripulante1: report.total_crew1,
                        total_tripulante2: report.total_crew2,
                        total_cliente: report.total_client || 0,
                        total_sharebrasil: report.total_sharebrasil || 0,
                        valor_total: report.total_amount || 0
                      };

                      await previewPDFForPrint(pdfReport);
                    } catch (error) {
                      console.error('Erro ao visualizar PDF:', error);
                      toast.error('Erro ao abrir visualização do relatório');
                    }
                  };

                  return (
                    <div
                      key={report.id}
                      className="p-4 bg-muted/50 rounded-lg border border-border"
                    >
                      <div className="space-y-3">
                        <div className="flex justify-between items-start gap-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              <p className="font-medium text-foreground">{report.report_number}</p>
                              <Badge
                                variant="outline"
                                className={
                                  report.status?.toLowerCase() === 'pago' || report.status?.toLowerCase() === 'conferido'
                                    ? 'bg-green-500/20 text-green-300'
                                    : 'bg-yellow-500/20 text-yellow-300'
                                }
                              >
                                {report.status?.toLowerCase() === 'pago' || report.status?.toLowerCase() === 'conferido' ? 'Conferido' : 'Pendente'}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Emitido em: {new Date(report.created_at).toLocaleDateString('pt-BR')}
                            </p>
                            {report.observations && (
                              <p className="text-sm text-muted-foreground mt-1">
                                {report.observations}
                              </p>
                            )}
                            {report.total_amount && (
                              <p className="text-sm font-semibold text-green-400 mt-1">
                                Valor: R$ {parseFloat(report.total_amount as any).toFixed(2)}
                              </p>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleViewPDF}
                            className="gap-2"
                            title="Visualizar PDF"
                          >
                            <Eye className="h-4 w-4" />
                            Ver PDF
                          </Button>
                        </div>

                        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-border">
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">Prazo de Pagamento</p>
                            <p className="text-sm text-foreground">
                              {report.payment_term ? new Date(report.payment_term).toLocaleDateString('pt-BR') : 'Não definido'}
                            </p>
                          </div>

                          <div>
                            <p className="text-xs text-muted-foreground mb-1">Status</p>
                            <Badge
                              className={
                                report.status?.toLowerCase() === 'pago' || report.status?.toLowerCase() === 'recebido'
                                  ? 'bg-green-500/20 text-green-300'
                                  : report.status?.toLowerCase() === 'enviado'
                                    ? 'bg-blue-500/20 text-blue-300'
                                    : 'bg-yellow-500/20 text-yellow-300'
                              }
                            >
                              {report.status?.toLowerCase() === 'pago' || report.status?.toLowerCase() === 'recebido'
                                ? 'Conferido'
                                : report.status?.toLowerCase() === 'enviado'
                                  ? 'Enviado'
                                  : 'Pendente'}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="envio-despesa" className="space-y-4">
          <Card className="bg-gradient-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Send className="h-5 w-5 text-primary" />
                Envio de Despesa ao Cliente
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Envie despesas diretamente para o cliente, selecionando um fornecedor favorito.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EnvioDespesaTab fornecedores={fornecedoresShare} clientId={clientId} aircraftId={aircraftId} />
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>

      <FileUploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        clientId={clientId}
        aircraftId={aircraftId}
        onSuccess={() => loadData(clientId)}
      />

      <ContractUploadDialog
        open={contractUploadDialogOpen}
        onOpenChange={setContractUploadDialogOpen}
        clientId={clientId}
        onSuccess={() => loadData(clientId)}
      />

      {/* Exemplo de uso do EnvioDespesaTab, ajuste conforme necessário */}
      {/* 
      <EnvioDespesaTab
        fornecedores={fornecedoresShare}
        // ...outras props...
      />
      */}
    </>
  );
}